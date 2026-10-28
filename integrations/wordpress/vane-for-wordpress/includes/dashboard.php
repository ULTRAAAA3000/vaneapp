<?php
if (!defined('ABSPATH')) {
    exit;
}

/** Who may write and send posts from the dashboard. Editors and up by default; change it with the `vane_capability` filter. */
function vane_wp_cap() {
    return apply_filters('vane_capability', 'edit_others_posts');
}

add_action('admin_menu', function () {
    add_menu_page('Vane', 'Vane', vane_wp_cap(), 'vane-for-wordpress', 'vane_wp_render_page', 'dashicons-share', 58);
});

function vane_wp_render_page() {
    if (!current_user_can(vane_wp_cap())) {
        return;
    }
    echo '<div class="wrap vane-wrap"><div id="vane-app"><p>' . esc_html__('Loading Vane…', 'vane-for-wordpress') . '</p></div>';
    echo '<noscript><p>' . esc_html__('The Vane dashboard needs JavaScript.', 'vane-for-wordpress') . '</p></noscript></div>';
}

add_action('admin_enqueue_scripts', function ($hook) {
    if ($hook !== 'toplevel_page_vane-for-wordpress' || !current_user_can(vane_wp_cap())) {
        return;
    }
    wp_enqueue_media();
    wp_enqueue_style('vane-wp-admin', VANE_WP_URL . 'assets/admin.css', array(), VANE_WP_VERSION);
    wp_enqueue_script('vane-wp-admin', VANE_WP_URL . 'assets/admin.js', array('wp-api-fetch', 'wp-i18n'), VANE_WP_VERSION, true);
    wp_localize_script('vane-wp-admin', 'VANE_ADMIN', array(
        'limits'    => vane_wp_limits(),
        'canManage' => current_user_can('manage_options'),
        'dashboard' => 'https://post.vaneapp.dev/',
        'keysHelp'  => 'https://vaneapp.dev/wordpress',
        'siteTime'  => wp_timezone_string(),
    ));
});

// ───────────────────────── REST (the browser only ever talks to WordPress; the key stays on the server) ─────────────────────────

function vane_wp_allow() {
    return current_user_can(vane_wp_cap());
}

function vane_wp_allow_manage() {
    return current_user_can('manage_options');
}

function vane_wp_reply($res) {
    return is_wp_error($res) ? new WP_Error($res->get_error_code(), $res->get_error_message(), array('status' => (int) ($res->get_error_data()['status'] ?? 400))) : rest_ensure_response($res);
}

add_action('rest_api_init', function () {
    register_rest_route('vane/v1', '/status', array(
        'methods'             => 'GET',
        'permission_callback' => 'vane_wp_allow',
        'callback'            => function () {
            $key = vane_wp_api_key();
            $out = array(
                'configured' => vane_wp_valid_key($key),
                'keyMasked'  => vane_wp_mask_key($key),
                'auto'       => (bool) get_option('vane_auto', true),
                'defaults'   => array_values((array) get_option('vane_default_channels', array())),
            );
            if (!$out['configured']) {
                return rest_ensure_response($out);
            }
            $me = vane_wp_request('GET', '/me');
            if (is_wp_error($me)) {
                $out['error'] = $me->get_error_message();
                return rest_ensure_response($out);
            }
            $out['mode'] = $me['key']['mode'];
            $out['plan'] = $me['plan'];
            $usage = vane_wp_request('GET', '/usage');
            if (!is_wp_error($usage)) {
                $out['usage'] = array('api' => $usage['usage']['api'] ?? null, 'resetsAt' => $usage['usage']['period']['resetsAt'] ?? null);
            }
            return rest_ensure_response($out);
        },
    ));

    register_rest_route('vane/v1', '/settings', array(
        'methods'             => 'POST',
        'permission_callback' => 'vane_wp_allow_manage',
        'callback'            => function ($request) {
            $p = $request->get_json_params();
            if (!is_array($p)) {
                $p = array();
            }
            if (array_key_exists('apiKey', $p)) {
                $key = trim((string) $p['apiKey']);
                if ($key === '') {
                    delete_option('vane_api_key');
                    delete_option('vane_default_channels');
                } elseif (!vane_wp_valid_key($key)) {
                    return new WP_Error('vane_bad_key', __('That does not look like a Vane API key (cpost_live_… or cpost_test_…).', 'vane-for-wordpress'), array('status' => 400));
                } else {
                    update_option('vane_api_key', $key);
                    $me = vane_wp_request('GET', '/me');
                    if (is_wp_error($me)) {
                        delete_option('vane_api_key');
                        return new WP_Error($me->get_error_code(), $me->get_error_message(), array('status' => 400));
                    }
                }
            }
            if (array_key_exists('auto', $p)) {
                update_option('vane_auto', $p['auto'] ? 1 : 0);
            }
            if (array_key_exists('defaults', $p)) {
                update_option('vane_default_channels', vane_wp_clean_channels($p['defaults']));
            }
            return rest_ensure_response(array('ok' => true));
        },
    ));

    register_rest_route('vane/v1', '/posts', array(
        array(
            'methods'             => 'GET',
            'permission_callback' => 'vane_wp_allow',
            'args'                => array('view' => array('type' => 'string', 'enum' => array('upcoming', 'history'), 'default' => 'upcoming')),
            'callback'            => function ($request) {
                $res = vane_wp_request('GET', '/posts?view=' . rawurlencode($request['view']));
                return is_wp_error($res) ? vane_wp_reply($res) : rest_ensure_response(array('posts' => $res['posts']));
            },
        ),
        array(
            'methods'             => 'POST',
            'permission_callback' => 'vane_wp_allow',
            'callback'            => function ($request) {
                $p = $request->get_json_params();
                $text = is_array($p) && isset($p['content']) ? trim((string) $p['content']) : '';
                $ids = is_array($p) && isset($p['channelIds']) ? array_values(array_filter(array_map('strval', (array) $p['channelIds']))) : array();
                if ($text === '' || !$ids) {
                    return new WP_Error('vane_empty', __('Write something and choose at least one channel.', 'vane-for-wordpress'), array('status' => 400));
                }
                $at = is_array($p) && !empty($p['scheduledAt']) ? strtotime((string) $p['scheduledAt']) : false;
                $when = ($at && $at > time() + 60) ? $at : time() + 60;
                $body = array('content' => $text, 'channelIds' => $ids, 'scheduledAt' => gmdate('Y-m-d\TH:i:s\Z', $when));
                if (!empty($p['mediaUrl']) && strpos((string) $p['mediaUrl'], 'https://') === 0) {
                    $body['mediaUrl'] = (string) $p['mediaUrl'];
                }
                $nonce = is_array($p) && !empty($p['requestId']) ? preg_replace('/[^A-Za-z0-9-]/', '', substr((string) $p['requestId'], 0, 40)) : wp_generate_uuid4();
                $res = vane_wp_request('POST', '/posts', $body, array('Idempotency-Key' => 'wpui-' . $nonce));
                if (is_wp_error($res)) {
                    return vane_wp_reply($res);
                }
                return rest_ensure_response(array('ok' => true, 'groupId' => $res['groupId'], 'scheduledAt' => $res['scheduledAt'], 'test' => !empty($res['test'])));
            },
        ),
    ));

    register_rest_route('vane/v1', '/posts/(?P<id>[0-9a-fA-F-]{36})', array(
        'methods'             => 'DELETE',
        'permission_callback' => 'vane_wp_allow',
        'callback'            => function ($request) {
            $res = vane_wp_request('DELETE', '/posts/' . $request['id']);
            return vane_wp_reply($res);
        },
    ));
});

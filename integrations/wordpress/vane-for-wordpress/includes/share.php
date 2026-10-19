<?php
if (!defined('ABSPATH')) {
    exit;
}

/** Text limits per network; Vane checks them again, this only keeps the automatic text inside the smallest one. */
function vane_wp_limits() {
    return array('telegram' => 4096, 'bluesky' => 300, 'mastodon' => 500, 'threads' => 500, 'x' => 280, 'linkedin' => 3000, 'webhook' => 10000);
}

function vane_wp_len($s) {
    return function_exists('mb_strlen') ? mb_strlen($s, 'UTF-8') : strlen($s);
}

function vane_wp_cut($s, $n) {
    if (vane_wp_len($s) <= $n) {
        return $s;
    }
    $n = max(0, $n - 1);
    return rtrim(function_exists('mb_substr') ? mb_substr($s, 0, $n, 'UTF-8') : substr($s, 0, $n)) . '…';
}

/** "Title, a piece of the excerpt, link" in at most $limit characters. The link is never cut. Mirrored in assets/sidebar.js. */
function vane_wp_compose($title, $excerpt, $url, $limit) {
    $tail = "\n\n" . $url;
    $title = vane_wp_cut(trim($title), max(10, $limit - vane_wp_len($tail)));
    $room = $limit - vane_wp_len($title . $tail) - 2;
    $body = $title;
    if ($excerpt !== '' && $room >= 20) {
        $body .= "\n\n" . vane_wp_cut(trim($excerpt), $room);
    }
    return $body . $tail;
}

function vane_wp_excerpt($post) {
    $text = $post->post_excerpt !== '' ? $post->post_excerpt : wp_strip_all_tags(strip_shortcodes($post->post_content));
    return trim(wp_trim_words(html_entity_decode($text, ENT_QUOTES, 'UTF-8'), 40, ''));
}

function vane_wp_post_types() {
    return apply_filters('vane_post_types', array('post'));
}

// ───────────────────────── meta shown in the editor ─────────────────────────

add_action('init', function () {
    $auth = function ($allowed, $meta_key, $post_id) {
        return current_user_can('edit_post', $post_id);
    };
    $deny = function () {
        return false;
    };
    foreach (vane_wp_post_types() as $type) {
        register_post_meta($type, '_vane_enabled', array('type' => 'boolean', 'single' => true, 'show_in_rest' => true, 'auth_callback' => $auth));
        register_post_meta($type, '_vane_channels', array('type' => 'string', 'single' => true, 'show_in_rest' => true, 'auth_callback' => $auth));
        register_post_meta($type, '_vane_text', array('type' => 'string', 'single' => true, 'show_in_rest' => true, 'auth_callback' => $auth));
        // Written only by the plugin itself
        register_post_meta($type, '_vane_posted', array('type' => 'string', 'single' => true, 'show_in_rest' => true, 'auth_callback' => $deny));
        register_post_meta($type, '_vane_error', array('type' => 'string', 'single' => true, 'show_in_rest' => true, 'auth_callback' => $deny));
    }
});

// ───────────────────────── publish trigger ─────────────────────────

/** Posts that just went from "not published" to "published" in this request (updating an old article never shares it). */
$GLOBALS['vane_wp_fresh'] = array();

add_action('transition_post_status', function ($new, $old, $post) {
    if ($new === 'publish' && $old !== 'publish' && in_array($post->post_type, vane_wp_post_types(), true)) {
        $GLOBALS['vane_wp_fresh'][$post->ID] = true;
    }
}, 10, 3);

// Block editor: the REST request saves the meta AFTER the post, so this hook (which runs after both) sees what the sidebar chose.
add_action('rest_after_insert_post', function ($post) {
    vane_wp_on_published($post);
}, 10, 1);

// Classic editor, scheduled posts (WP-Cron), imports: no REST request, the saved meta is already there.
add_action('publish_post', function ($id, $post) {
    if (defined('REST_REQUEST') && REST_REQUEST) {
        return;
    }
    vane_wp_on_published($post);
}, 10, 2);

function vane_wp_on_published($post) {
    if (empty($GLOBALS['vane_wp_fresh'][$post->ID])) {
        return;
    }
    unset($GLOBALS['vane_wp_fresh'][$post->ID]);
    $enabled = get_post_meta($post->ID, '_vane_enabled', true);
    $on = $enabled === '' ? (bool) get_option('vane_auto', true) : (bool) $enabled;
    if ($on && apply_filters('vane_should_share', true, $post)) {
        vane_wp_share($post);
    }
}

/** Sends the post to Vane. Stores the outcome in the post's meta. Returns true or a WP_Error. */
function vane_wp_share($post) {
    if (get_post_meta($post->ID, '_vane_posted', true) !== '') {
        return new WP_Error('vane_done', __('This article was already sent to Vane.', 'vane-for-wordpress'));
    }

    $chosen = json_decode((string) get_post_meta($post->ID, '_vane_channels', true), true);
    $ids = is_array($chosen) ? $chosen : (array) get_option('vane_default_channels', array());
    $ids = array_values(array_filter(array_map('strval', $ids)));
    if (!$ids) {
        return vane_wp_fail($post, new WP_Error('vane_no_channels', __('No channels selected.', 'vane-for-wordpress')));
    }

    $url = get_permalink($post);
    $custom = (string) get_post_meta($post->ID, '_vane_text', true);
    if (trim($custom) !== '') {
        $text = str_replace('{url}', $url, $custom);
    } else {
        $limit = 4096;
        $channels = vane_wp_channels();
        if (!is_wp_error($channels)) {
            $limits = vane_wp_limits();
            foreach ($channels as $c) {
                if (in_array($c['id'], $ids, true) && isset($limits[$c['platform']])) {
                    $limit = min($limit, $limits[$c['platform']]);
                }
            }
        }
        $text = vane_wp_compose(html_entity_decode(get_the_title($post), ENT_QUOTES, 'UTF-8'), vane_wp_excerpt($post), $url, $limit);
    }

    $body = array(
        'content'     => $text,
        'channelIds'  => $ids,
        'scheduledAt' => gmdate('Y-m-d\TH:i:s\Z', time() + 60),
    );
    $image = get_the_post_thumbnail_url($post, 'large');
    if ($image && strpos($image, 'https://') === 0) {
        $body['mediaUrl'] = $image;
    }

    // The same article and the same text can never be sent twice, whatever retries happen.
    $idem = 'wp-' . $post->ID . '-' . substr(sha1($text . '|' . implode(',', $ids)), 0, 20);
    $res = vane_wp_request('POST', '/posts', $body, array('Idempotency-Key' => $idem));
    if (is_wp_error($res)) {
        return vane_wp_fail($post, $res);
    }
    update_post_meta($post->ID, '_vane_posted', (string) $res['groupId']);
    delete_post_meta($post->ID, '_vane_error');
    return true;
}

function vane_wp_fail($post, $error) {
    update_post_meta($post->ID, '_vane_error', $error->get_error_message());
    return $error;
}

<?php
if (!defined('ABSPATH')) {
    exit;
}

add_action('rest_api_init', function () {
    register_rest_route('vane/v1', '/channels', array(
        'methods'             => 'GET',
        'permission_callback' => function () {
            return current_user_can('edit_posts');
        },
        'callback'            => function () {
            $channels = vane_wp_channels();
            return is_wp_error($channels) ? $channels : rest_ensure_response($channels);
        },
    ));

    // "Send now": for an article that is already published (the first send failed, or the plugin was added later).
    register_rest_route('vane/v1', '/share', array(
        'methods'             => 'POST',
        'permission_callback' => function ($request) {
            return current_user_can('edit_post', (int) $request['post_id']);
        },
        'args'                => array('post_id' => array('required' => true, 'type' => 'integer')),
        'callback'            => function ($request) {
            $post = get_post((int) $request['post_id']);
            if (!$post || $post->post_status !== 'publish') {
                return new WP_Error('vane_not_published', __('Publish the article first.', 'vane-for-wordpress'), array('status' => 400));
            }
            $res = vane_wp_share($post);
            return is_wp_error($res) ? $res : rest_ensure_response(array('ok' => true, 'groupId' => get_post_meta($post->ID, '_vane_posted', true)));
        },
    ));
});

add_action('enqueue_block_editor_assets', function () {
    $screen = function_exists('get_current_screen') ? get_current_screen() : null;
    if (!$screen || !in_array($screen->post_type, vane_wp_post_types(), true)) {
        return;
    }
    wp_enqueue_script(
        'vane-wp-sidebar',
        VANE_WP_URL . 'assets/sidebar.js',
        array('wp-plugins', 'wp-editor', 'wp-edit-post', 'wp-element', 'wp-components', 'wp-data', 'wp-api-fetch', 'wp-i18n'),
        VANE_WP_VERSION,
        true
    );
    wp_localize_script('vane-wp-sidebar', 'VANE_WP', array(
        'configured'  => vane_wp_valid_key(vane_wp_api_key()),
        'auto'        => (bool) get_option('vane_auto', true),
        'defaults'    => array_values((array) get_option('vane_default_channels', array())),
        'limits'      => vane_wp_limits(),
        'settingsUrl' => admin_url('options-general.php?page=vane-for-wordpress'),
    ));
});

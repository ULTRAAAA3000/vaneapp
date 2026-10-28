<?php
if (!defined('ABSPATH')) {
    exit;
}

/** Settings are saved from the Vane dashboard page (includes/dashboard.php); these are the rules they pass through. */

function vane_wp_clean_channels($value) {
    return array_values(array_filter(array_map('sanitize_text_field', (array) $value)));
}

function vane_wp_mask_key($key) {
    return $key === '' ? '' : 'cpost_' . (strpos($key, 'cpost_test_') === 0 ? 'test' : 'live') . '_••••' . substr($key, -4);
}

add_action('admin_init', function () {
    register_setting('vane_wp', 'vane_api_key', array('type' => 'string', 'sanitize_callback' => 'sanitize_text_field'));
    register_setting('vane_wp', 'vane_auto', array('type' => 'boolean', 'default' => true, 'sanitize_callback' => function ($v) {
        return $v ? 1 : 0;
    }));
    register_setting('vane_wp', 'vane_default_channels', array('type' => 'array', 'default' => array(), 'sanitize_callback' => 'vane_wp_clean_channels'));
});

add_filter('plugin_action_links_' . plugin_basename(VANE_WP_DIR . 'vane-for-wordpress.php'), function ($links) {
    array_unshift($links, '<a href="' . esc_url(admin_url('admin.php?page=vane-for-wordpress')) . '">' . esc_html__('Open Vane', 'vane-for-wordpress') . '</a>');
    return $links;
});

// The old address (Settings → Vane) keeps working: it opens the dashboard.
add_action('admin_menu', function () {
    add_options_page('Vane', 'Vane', 'manage_options', 'vane-for-wordpress-settings', '__return_null');
});
add_action('load-settings_page_vane-for-wordpress-settings', function () {
    wp_safe_redirect(admin_url('admin.php?page=vane-for-wordpress&tab=settings'));
    exit;
});

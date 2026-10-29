<?php
/**
 * Plugin Name: Vane for WordPress
 * Plugin URI: https://vaneapp.dev
 * Description: Write and schedule social posts from WordPress with Vane, and cross-post your articles to Telegram, Bluesky, Mastodon and more when you publish.
 * Version: 2.0.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Author: Vane
 * License: GPLv2 or later
 * Text Domain: vane-for-wordpress
 */

if (!defined('ABSPATH')) {
    exit;
}

define('VANE_WP_VERSION', '2.0.0');
define('VANE_WP_DIR', plugin_dir_path(__FILE__));
define('VANE_WP_URL', plugin_dir_url(__FILE__));

require_once VANE_WP_DIR . 'includes/api.php';
require_once VANE_WP_DIR . 'includes/settings.php';
require_once VANE_WP_DIR . 'includes/share.php';
require_once VANE_WP_DIR . 'includes/editor.php';
require_once VANE_WP_DIR . 'includes/dashboard.php';

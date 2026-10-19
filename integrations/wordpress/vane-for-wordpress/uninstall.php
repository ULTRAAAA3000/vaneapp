<?php
if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}
delete_option('vane_api_key');
delete_option('vane_auto');
delete_option('vane_default_channels');

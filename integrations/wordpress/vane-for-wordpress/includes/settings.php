<?php
if (!defined('ABSPATH')) {
    exit;
}

add_action('admin_menu', function () {
    add_options_page('Vane', 'Vane', 'manage_options', 'vane-for-wordpress', 'vane_wp_settings_page');
});

add_action('admin_init', function () {
    register_setting('vane_wp', 'vane_api_key', array(
        'type'              => 'string',
        'sanitize_callback' => function ($value) {
            $value = trim((string) $value);
            if ($value === '') {
                return vane_wp_api_key();
            }
            if (!vane_wp_valid_key($value)) {
                add_settings_error('vane_api_key', 'vane_bad_key', __('That does not look like a Vane API key (cpost_live_… or cpost_test_…).', 'vane-for-wordpress'));
                return vane_wp_api_key();
            }
            return $value;
        },
    ));
    register_setting('vane_wp', 'vane_auto', array(
        'type'              => 'boolean',
        'default'           => true,
        'sanitize_callback' => function ($value) {
            return $value ? 1 : 0;
        },
    ));
    register_setting('vane_wp', 'vane_default_channels', array(
        'type'              => 'array',
        'default'           => array(),
        'sanitize_callback' => function ($value) {
            return array_values(array_filter(array_map('sanitize_text_field', (array) $value)));
        },
    ));
});

add_filter('plugin_action_links_' . plugin_basename(VANE_WP_DIR . 'vane-for-wordpress.php'), function ($links) {
    array_unshift($links, '<a href="' . esc_url(admin_url('options-general.php?page=vane-for-wordpress')) . '">' . esc_html__('Settings', 'vane-for-wordpress') . '</a>');
    return $links;
});

function vane_wp_settings_page() {
    if (!current_user_can('manage_options')) {
        return;
    }
    $key = vane_wp_api_key();
    $defaults = (array) get_option('vane_default_channels', array());
    $me = null;
    $channels = array();
    if ($key !== '') {
        $me = vane_wp_request('GET', '/me');
        if (!is_wp_error($me)) {
            $channels = vane_wp_channels();
        }
    }
    ?>
    <div class="wrap">
        <h1>Vane for WordPress</h1>
        <form method="post" action="options.php">
            <?php settings_fields('vane_wp'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="vane_api_key"><?php esc_html_e('API key', 'vane-for-wordpress'); ?></label></th>
                    <td>
                        <input type="password" id="vane_api_key" name="vane_api_key" value="" class="regular-text" autocomplete="off"
                               placeholder="<?php echo $key !== '' ? esc_attr('cpost_' . (strpos($key, 'cpost_test_') === 0 ? 'test' : 'live') . '_••••' . substr($key, -4)) : 'cpost_live_…'; ?>">
                        <p class="description"><?php esc_html_e('Create it in the Vane dashboard under API keys. Leave empty to keep the saved key. A cpost_test_ key tries everything without posting.', 'vane-for-wordpress'); ?></p>
                        <?php if ($me !== null): ?>
                            <?php if (is_wp_error($me)): ?>
                                <p style="color:#b32d2e"><strong><?php echo esc_html($me->get_error_message()); ?></strong></p>
                            <?php else: ?>
                                <p style="color:#00a32a"><strong><?php echo esc_html(sprintf(__('Connected: %1$s plan, %2$s key.', 'vane-for-wordpress'), $me['plan'], $me['key']['mode'])); ?></strong></p>
                            <?php endif; ?>
                        <?php endif; ?>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><?php esc_html_e('Publishing', 'vane-for-wordpress'); ?></th>
                    <td>
                        <label><input type="checkbox" name="vane_auto" value="1" <?php checked((bool) get_option('vane_auto', true)); ?>>
                            <?php esc_html_e('Cross-post new articles when they are published (can be turned off per article in the editor)', 'vane-for-wordpress'); ?></label>
                    </td>
                </tr>
                <?php if (!empty($channels) && !is_wp_error($channels)): ?>
                <tr>
                    <th scope="row"><?php esc_html_e('Default channels', 'vane-for-wordpress'); ?></th>
                    <td>
                        <?php foreach ($channels as $c): ?>
                            <label style="display:block"><input type="checkbox" name="vane_default_channels[]" value="<?php echo esc_attr($c['id']); ?>" <?php checked(in_array($c['id'], $defaults, true)); ?>>
                                <?php echo esc_html($c['name'] . ' (' . $c['platform'] . ')'); ?></label>
                        <?php endforeach; ?>
                        <p class="description"><?php esc_html_e('Pre-selected for every new article.', 'vane-for-wordpress'); ?></p>
                    </td>
                </tr>
                <?php endif; ?>
            </table>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}

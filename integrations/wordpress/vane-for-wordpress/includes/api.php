<?php
if (!defined('ABSPATH')) {
    exit;
}

/** Where the Vane API lives. Only a filter can change it, never a setting, so a stolen admin session cannot redirect the key. */
function vane_wp_api_base() {
    $base = apply_filters('vane_api_base', 'https://vaneapp.dev/api/v1');
    return untrailingslashit($base);
}

function vane_wp_api_key() {
    return (string) get_option('vane_api_key', '');
}

function vane_wp_valid_key($key) {
    return (bool) preg_match('/^cpost_(live|test)_[A-Za-z0-9]{24}$/', $key);
}

/**
 * One call to the Vane API. Returns the decoded JSON (array) or a WP_Error whose message is safe to show.
 */
function vane_wp_request($method, $path, $body = null, $headers = array()) {
    $key = vane_wp_api_key();
    if (!vane_wp_valid_key($key)) {
        return new WP_Error('vane_no_key', __('Add your Vane API key under Settings → Vane.', 'vane-for-wordpress'));
    }

    $args = array(
        'method'  => $method,
        'timeout' => 15,
        'headers' => array_merge(array(
            'Authorization' => 'Bearer ' . $key,
            'Accept'        => 'application/json',
            'User-Agent'    => 'Vane-for-WordPress/' . VANE_WP_VERSION,
        ), $headers),
    );
    if ($body !== null) {
        $args['headers']['Content-Type'] = 'application/json';
        $args['body'] = wp_json_encode($body);
    }

    $res = wp_remote_request(vane_wp_api_base() . $path, $args);
    if (is_wp_error($res)) {
        return new WP_Error('vane_unreachable', sprintf(__('Could not reach Vane: %s', 'vane-for-wordpress'), $res->get_error_message()));
    }

    $status = wp_remote_retrieve_response_code($res);
    $data = json_decode(wp_remote_retrieve_body($res), true);
    if ($status < 200 || $status >= 300 || !is_array($data) || empty($data['ok'])) {
        $message = is_array($data) && !empty($data['error']) ? $data['error'] : sprintf(__('Vane answered HTTP %d.', 'vane-for-wordpress'), $status);
        return new WP_Error(is_array($data) && !empty($data['code']) ? $data['code'] : 'vane_http_' . $status, $message, array('status' => $status));
    }
    return $data;
}

/** The connected channels that can take a post. */
function vane_wp_channels() {
    $data = vane_wp_request('GET', '/channels');
    if (is_wp_error($data)) {
        return $data;
    }
    $out = array();
    foreach ((array) $data['channels'] as $c) {
        if (!empty($c['isActive'])) {
            $out[] = array('id' => $c['id'], 'platform' => $c['platform'], 'name' => $c['name']);
        }
    }
    return $out;
}

<?php
/**
 * Plugin Name: ACTION Linecard Export API
 * Description: Provides a private REST endpoint for exporting linecard_21 products to HookTea shop.
 * Version: 1.0.0
 */

if (!defined('ABSPATH')) {
    exit;
}

add_action('rest_api_init', function () {
    register_rest_route('action-import/v1', '/linecard-products', array(
        'methods' => 'GET',
        'callback' => 'action_linecard_export_products',
        'permission_callback' => function () {
            return current_user_can('edit_posts');
        },
        'args' => array(
            'ids' => array(
                'required' => true,
                'sanitize_callback' => 'sanitize_text_field',
            ),
        ),
    ));
});

function action_linecard_meta_first($post_id, $keys, $fallback = '') {
    foreach ($keys as $key) {
        $value = get_post_meta($post_id, $key, true);
        if ($value !== '' && $value !== null) {
            return $value;
        }
    }
    return $fallback;
}

function action_linecard_export_products(WP_REST_Request $request) {
    $ids = preg_split('/[\s,，]+/', (string) $request->get_param('ids'));
    $ids = array_values(array_filter(array_map('absint', $ids)));

    $products = array();
    foreach ($ids as $post_id) {
        $post = get_post($post_id);
        if (!$post || $post->post_type !== 'linecard_21') {
            continue;
        }

        $image = get_the_post_thumbnail_url($post_id, 'full');
        $code = action_linecard_meta_first($post_id, array(
            'product_code',
            'linecard_code',
            'sku',
            '商品代碼',
        ));
        $store_name = action_linecard_meta_first($post_id, array(
            'store_name',
            'shop_name',
            'vendor',
            '店家名稱',
        ), 'HookTea');
        $status = action_linecard_meta_first($post_id, array(
            'product_status',
            'sell_status',
            '商品狀態',
        ), '販賣中');
        $points_price = action_linecard_meta_first($post_id, array(
            'points_price',
            'point_price',
            'price',
            '點數價格',
            '價格',
        ), 0);

        $products[] = array(
            'id' => 'PROD_wp_' . $post_id,
            'postId' => $post_id,
            'name' => get_the_title($post_id),
            'code' => (string) $code,
            'storeName' => (string) $store_name,
            'status' => (string) $status,
            'price' => floatval($points_price),
            'pointsPrice' => floatval($points_price),
            'image' => $image ? esc_url_raw($image) : '',
            'description' => wp_strip_all_tags($post->post_content ?: $post->post_excerpt),
            'sourceUrl' => get_edit_post_link($post_id, ''),
            'isPublished' => true,
        );
    }

    return rest_ensure_response(array(
        'success' => true,
        'products' => $products,
    ));
}

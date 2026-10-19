<?php
// The web app manifest, named after this webmail, so it installs to the home screen like an app.
declare(strict_types=1);

require __DIR__ . '/app/bootstrap.php';

use Webmail\Config;

$name = Config::installed() ? (string) Config::load()->get('app_name', 'Webmail') : 'Webmail';
header('Content-Type: application/manifest+json; charset=utf-8');
header('Cache-Control: public, max-age=3600');
echo json_encode([
    'name' => $name,
    'short_name' => mb_substr($name, 0, 12),
    'description' => 'Read and send your email.',
    'id' => './',
    'start_url' => './',
    'scope' => './',
    'display' => 'standalone',
    'background_color' => '#ffffff',
    'theme_color' => '#2563eb',
    'icons' => [
        ['src' => 'assets/icons/icon-192.png', 'sizes' => '192x192', 'type' => 'image/png'],
        ['src' => 'assets/icons/icon-512.png', 'sizes' => '512x512', 'type' => 'image/png'],
        ['src' => 'assets/icons/maskable-192.png', 'sizes' => '192x192', 'type' => 'image/png', 'purpose' => 'maskable'],
        ['src' => 'assets/icons/maskable-512.png', 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'maskable'],
        ['src' => 'assets/icons/icon.svg', 'sizes' => 'any', 'type' => 'image/svg+xml'],
    ],
    'shortcuts' => [['name' => 'Compose', 'url' => './#compose', 'icons' => [['src' => 'assets/icons/icon-192.png', 'sizes' => '192x192']]]],
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);

<?php
// The webmail's single page. The interface (assets/app.js) talks to api.php.
declare(strict_types=1);

require __DIR__ . '/app/bootstrap.php';

use Webmail\Config;
use Webmail\Http;

if (!Config::installed()) {
    header('Location: install.php');
    exit;
}
$config = Config::load();
$name = htmlspecialchars((string) $config->get('app_name', 'Webmail'), ENT_QUOTES | ENT_HTML5, 'UTF-8');
$v = \Webmail\App::VERSION;
Http::securityHeaders();
header('Cache-Control: no-cache');
// Scripts and styles only from here; message bodies are shown in a sandboxed frame from api.php.
header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
?><!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#2563eb">
  <title><?= $name ?></title>
  <link rel="manifest" href="manifest.php">
  <link rel="icon" href="assets/icons/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="assets/icons/icon-192.png">
  <link rel="stylesheet" href="assets/app.css?v=<?= $v ?>">
  <script src="assets/pwa.js?v=<?= $v ?>" defer></script>
  <script src="assets/app.js?v=<?= $v ?>" defer></script>
</head>
<body>
  <div id="app" data-name="<?= $name ?>"><div class="boot"><span class="logo" aria-hidden="true"></span></div></div>
  <noscript>This webmail needs JavaScript.</noscript>
</body>
</html>

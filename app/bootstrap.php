<?php
declare(strict_types=1);

// The app's classes load from app/ by name (Webmail\Foo is app/Foo.php): no Composer needed on the server.
spl_autoload_register(static function (string $class): void {
    if (str_starts_with($class, 'Webmail\\')) {
        $file = __DIR__ . '/' . str_replace('\\', '/', substr($class, 8)) . '.php';
        if (is_file($file)) {
            require $file;
        }
    }
});

if (PHP_VERSION_ID < 80100) {
    http_response_code(500);
    exit('This webmail needs PHP 8.1 or newer.');
}

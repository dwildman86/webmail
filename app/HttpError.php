<?php
declare(strict_types=1);

namespace Webmail;

/** An error to show the user, with its HTTP status. */
final class HttpError extends \RuntimeException
{
    /** @param array $data more for the page, alongside error and message */
    public function __construct(public readonly int $status, string $message, public readonly string $errorCode = 'error', public readonly array $data = [])
    {
        parent::__construct($message);
    }
}

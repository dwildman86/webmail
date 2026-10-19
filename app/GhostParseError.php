<?php
declare(strict_types=1);

namespace Webmail;

final class GhostParseError extends \RuntimeException
{
    public function __construct(string $message, public readonly int $status = 0, public readonly ?string $errorCode = null)
    {
        parent::__construct($message);
    }
}

<?php
declare(strict_types=1);

namespace Webmail;

/** Something went wrong talking to an old mail server; the message is for the person importing. */
final class ImapError extends \RuntimeException
{
}

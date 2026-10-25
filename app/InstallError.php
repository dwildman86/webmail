<?php
declare(strict_types=1);

namespace Webmail;

/** Why the webmail can't be installed with what was given; the message is for the person installing it. */
final class InstallError extends \RuntimeException
{
}

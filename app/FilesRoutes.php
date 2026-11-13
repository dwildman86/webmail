<?php
declare(strict_types=1);

namespace Webmail;

/** api.php?a=files/…, vault/… and admin/files…: Files, the private vault and their settings. */
final class FilesRoutes
{
    public function __construct(private App $app)
    {
    }

    public function route(string $action, string $method, array $user): never
    {
        $files = new Files($this->app);
        $raw = $action === 'files/upload/piece';
        $in = $method === 'GET' || $raw ? [] : Http::body();
        $int = fn (string $k, array $from = null): int => (int) (($from ?? ($method === 'GET' || $raw ? $_GET : $in))[$k] ?? 0);
        $nullable = fn (string $k): ?int => isset($in[$k]) && $in[$k] !== null && $in[$k] !== '' ? (int) $in[$k] : null;
        $admin = $user['role'] === 'admin';
        switch ("$method $action") {
            case 'GET files':
                Http::json($files->list($user, $_GET));
            case 'POST files/folder':
                Http::json($files->createFolder($user, $nullable('parent_id'), (string) ($in['name'] ?? ''), !empty($in['vault'])), 201);
            case 'POST files/rename':
                Http::json($files->rename($user, $int('id'), (string) ($in['name'] ?? '')));
            case 'POST files/move':
                Http::json($files->move($user, $int('id'), $nullable('to')));
            case 'POST files/copy':
                Http::json($files->copy($user, $int('id'), $nullable('to')), 201);
            case 'POST files/trash':
                foreach ((array) ($in['ids'] ?? [$in['id'] ?? 0]) as $id) {
                    $files->trash($user, (int) $id);
                }
                Http::json(['ok' => true]);
            case 'POST files/restore':
                Http::json($files->restore($user, $int('id')));
            case 'POST files/delete':
                $files->deleteForever($user, $int('id'));
                Http::json(['ok' => true]);
            case 'POST files/empty-trash':
                Http::json(['deleted' => $files->emptyTrash($user)]);
            case 'POST files/upload/start':
                Http::json($files->startUpload($user, $nullable('parent_id'), (string) ($in['name'] ?? ''), (int) ($in['size'] ?? -1), $nullable('node_id'), !empty($in['vault'])));
            case 'POST files/upload/piece':
                // The file's bytes, as the request body (not JSON), in order.
                Http::json($files->appendUpload($user, (string) ($_GET['u'] ?? ''), (int) ($_GET['offset'] ?? -1),
                    (string) file_get_contents('php://input', false, null, 0, Files::UPLOAD_PIECE + 1)));
            case 'GET files/download':
                $node = $files->need($user, $int('id'));
                if ($node['kind'] !== 'file') {
                    throw new HttpError(422, "That's a folder: download it as a ZIP.", 'not_file');
                }
                // Vault files are ciphertext to the server: the browser decrypts them, so they're never shown inline.
                $files->send($node, $files->currentVersion($node, $int('version') ?: null), !empty($_GET['inline']) && !$node['vault'], $_SERVER['HTTP_RANGE'] ?? null);
            case 'GET files/zip':
                $files->zip($user, $int('id'));
            case 'GET files/versions':
                Http::json(['versions' => $files->versions($user, $int('id'))]);
            case 'POST files/versions/restore':
                Http::json($files->restoreVersion($user, $int('id'), $int('version_id')));
            case 'GET files/shares':
                Http::json($files->shares($user, $int('id')));
            case 'GET files/share-candidates':
                Http::json($files->shareCandidates());
            case 'POST files/share':
                Http::json($files->share($user, $int('id'), $nullable('user_id'), $nullable('mailbox_id'), (string) ($in['role'] ?? '')));
            case 'POST files/unshare':
                $files->unshare($user, $int('share_id'));
                Http::json(['ok' => true]);
            case 'POST files/links':
                Http::json((new FileLinks($this->app))->create($user, $int('id'), (string) ($in['kind'] ?? 'view'), isset($in['password']) ? (string) $in['password'] : null,
                    $nullable('days'), $nullable('max_downloads')), 201);
            case 'POST files/links/revoke':
                (new FileLinks($this->app))->revoke($user, $int('id'));
                Http::json(['ok' => true]);
            case 'POST files/links/revoke-all':
                Http::json(['revoked' => (new FileLinks($this->app))->revokeAll((int) $user['id'])]);
            case 'GET files/activity':
                Http::json(['activity' => $files->activity($user, $int('id') ?: null)]);
            case 'POST files/from-attachment':
                // An email's attachment saved into Files.
                $a = (new Mailstore($this->app))->attachment((int) $user['id'], $int('attachment_id'));
                Http::json($files->storeBytes($user, $nullable('parent_id'), (string) $a['filename'], (string) $a['content']), 201);

            case 'GET vault':
                Http::json((new Vault($this->app))->status($user));
            case 'GET vault/keys':
                Http::json(['keys' => (new Vault($this->app))->keys($user)]);
            case 'POST vault/setup':
                Http::json((new Vault($this->app))->setup($user, (array) ($in['methods'] ?? [])));
            case 'POST vault/add':
                Http::json((new Vault($this->app))->add($user, (array) ($in['method'] ?? [])));
            case 'POST vault/remove':
                Http::json((new Vault($this->app))->remove($user, $int('id')));
            case 'POST vault/reset':
                (new Auth($this->app))->confirm((int) $user['id'], $in);
                (new Vault($this->app))->reset($user);
                Http::json(['ok' => true]);

            case 'GET admin/files':
                $this->admin($admin);
                $people = [];
                foreach ($files->people() as $id => $p) {
                    $people[] = ['id' => $id, 'name' => $p['name']] + $files->usage($id);
                }
                Http::json(['settings' => $files->publicSettings(), 'status' => $files->storeStatus(), 'allowed' => $files->allowed(true), 'people' => $people]);
            case 'POST admin/files':
                $this->admin($admin);
                (new Auth($this->app))->confirm((int) $user['id'], $in);
                // Turning share links off stops them at once: each is checked against the setting when opened.
                $settings = $files->saveSettings(array_diff_key($in, ['password' => 1, 'passkey' => 1]));
                Http::json(['settings' => $settings, 'status' => $files->storeStatus()]);
            case 'POST admin/files/test-s3':
                $this->admin($admin);
                $files->testS3((array) ($in['s3'] ?? []));
                Http::json(['ok' => true]);
            case 'POST admin/files/move':
                $this->admin($admin);
                Http::json($files->setMoving(!empty($in['on'])));
        }
        throw new HttpError(404, 'Unknown action', 'not_found');
    }

    private function admin(bool $is): void
    {
        if (!$is) {
            throw new HttpError(403, 'Only administrators can do that.', 'forbidden');
        }
    }
}

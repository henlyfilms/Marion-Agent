import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { env } from './env.js';
const exec = promisify(execFile);
const name = (id) => {
    if (!/^(bot|sub)_[a-zA-Z0-9_-]+$/.test(id))
        throw new Error('Invalid desktop ID');
    return `marion-desktop-${id}`;
};
async function docker(args, timeout = 30_000) {
    try {
        return await exec('docker', args, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout, windowsHide: true });
    }
    catch (error) {
        const failure = error;
        if (failure.code === 'ENOENT')
            throw new Error('Install Docker Desktop or Colima to use bot desktops.');
        const detail = failure.stderr?.toString() ?? failure.message;
        if (/cannot connect|connection refused|error during connect|daemon is not running/i.test(detail)) {
            throw new Error('Start Docker Desktop or Colima to wake this bot’s computer.');
        }
        throw error;
    }
}
let colimaStartup;
async function startConfiguredEngine() {
    try {
        await docker(['info', '--format', '{{.ServerVersion}}'], 3500);
    }
    catch (error) {
        if (process.platform !== 'darwin' || !String(error).includes('Start Docker Desktop or Colima'))
            throw error;
        const context = await docker(['context', 'show'], 2500);
        if (context.stdout.toString().trim() !== 'colima')
            throw error;
        colimaStartup ??= exec('colima', ['start'], { timeout: 180_000 }).then(() => undefined)
            .catch(() => { throw new Error('Colima could not start. Check its status on the Mac and try again.'); })
            .finally(() => { colimaStartup = undefined; });
        await colimaStartup;
    }
}
let imageCheck;
function ensureImage() {
    imageCheck ??= (async () => {
        try {
            await docker(['image', 'inspect', env.desktopImage]);
        }
        catch (error) {
            if (!/no such image/i.test(String(error)))
                throw error;
            if (env.desktopImage !== 'marion-agent-desktop:local')
                throw new Error(`Desktop image ${env.desktopImage} is unavailable in the active Docker context.`);
            const context = fileURLToPath(new URL('../../desktop/', import.meta.url));
            try {
                await docker(['build', '-t', env.desktopImage, context], 15 * 60_000);
            }
            catch {
                throw new Error('Could not build the bot desktop image. Check Docker and its internet connection, then wake the computer again.');
            }
        }
    })().finally(() => { imageCheck = undefined; });
    return imageCheck;
}
async function running(id) {
    try {
        const { stdout } = await docker(['container', 'inspect', '--format', '{{.State.Running}}', name(id)]);
        return stdout.toString().trim() === 'true';
    }
    catch (error) {
        if (/No such (object|container)/i.test(String(error)))
            return undefined;
        throw error;
    }
}
function command(id, args, timeout = 30_000) {
    return docker(['exec', '--', name(id), ...args], timeout);
}
const move = (x, y) => ['mousemove', '--', String(x), String(y)];
const mouseButton = { left: '1', middle: '2', right: '3' };
export const desktop = {
    running,
    async start(id) {
        let state;
        try {
            state = await running(id);
        }
        catch (error) {
            if (!String(error).includes('Start Docker Desktop or Colima'))
                throw error;
            await startConfiguredEngine();
            state = await running(id);
        }
        if (state === undefined) {
            await ensureImage();
            const network = name(id);
            try {
                await docker(['network', 'inspect', network]);
            }
            catch (error) {
                if (!/not found/i.test(String(error)))
                    throw error;
                await docker(['network', 'create', network]);
            }
            await docker([
                'run', '-d', '--init', '--name', name(id), '--pull=never',
                '--network', network, '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=384',
                '--memory=2g', '--cpus=2', '--shm-size=256m',
                '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
                '--mount', `type=volume,source=${name(id)},target=/workspace`,
                env.desktopImage,
            ], 60_000);
        }
        else if (!state) {
            await docker(['start', name(id)]);
        }
        for (let attempt = 0; attempt < 30; attempt++) {
            try {
                await command(id, ['xdotool', 'getdisplaygeometry'], 3000);
                return;
            }
            catch {
                if (!await running(id))
                    break;
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }
        throw new Error('Desktop display failed to start');
    },
    async stop(id) {
        if (await running(id))
            await docker(['stop', '--time', '5', name(id)]);
    },
    vnc(id) {
        return spawn('docker', ['exec', '-i', '--', name(id), 'socat', 'STDIO', 'TCP:127.0.0.1:5900'], { windowsHide: true });
    },
    async screenshot(id) {
        const { stdout } = await command(id, ['import', '-window', 'root', '-quality', '75', 'jpeg:-']);
        const { stdout: geometry } = await command(id, ['xdotool', 'getdisplaygeometry']);
        const [width, height] = geometry.toString().trim().split(/\s+/).map(Number);
        return { image: stdout.toString('base64'), mime_type: 'image/jpeg', width, height };
    },
    async readScreen(id) {
        const { stdout } = await command(id, ['bash', '-o', 'pipefail', '-c',
            'import -window root png:- | tesseract stdin stdout tsv 2>/dev/null'], 15_000);
        const words = stdout.toString().split('\n').flatMap(line => {
            const [level, , , , , , left, top, width, height, confidence, text] = line.split('\t');
            if (level !== '5' || Number(confidence) < 40 || !text?.trim())
                return [];
            return [`${text.trim()} (${Number(left) + Math.floor(Number(width) / 2)},${Number(top) + Math.floor(Number(height) / 2)})`];
        });
        return words.join(' ').slice(0, 8000);
    },
    click(id, b) {
        return command(id, ['xdotool', ...move(b.x, b.y), 'click', '--repeat', b.double ? '2' : '1', mouseButton[b.button] ?? '1']);
    },
    type(id, text) {
        return command(id, ['xdotool', 'type', '--clearmodifiers', '--', text]);
    },
    key(id, key) {
        if (!/^[a-zA-Z0-9_+]+$/.test(key))
            throw new Error('Invalid X11 key combination');
        return command(id, ['xdotool', 'key', '--clearmodifiers', key]);
    },
    scroll(id, b) {
        return command(id, ['xdotool', ...move(b.x, b.y), 'click', '--repeat', String(Math.max(1, Math.min(25, b.amount))), b.direction === 'up' ? '4' : '5']);
    },
    drag(id, b) {
        return command(id, ['xdotool', ...move(b.start_x, b.start_y), 'mousedown', '1', ...move(b.end_x, b.end_y), 'mouseup', '1']);
    },
    async bash(id, script, timeout = 120) {
        try {
            const { stdout, stderr } = await command(id, ['timeout', '--kill-after=5s', `${timeout}s`, 'bash', '-c', script], (timeout + 10) * 1000);
            return { exit_code: 0, output: stdout.toString() + stderr.toString() };
        }
        catch (error) {
            const e = error;
            if (typeof e.code !== 'number')
                throw error;
            return { exit_code: e.code, output: (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '') };
        }
    },
    save(id, file, data) {
        return new Promise((resolve, reject) => {
            const process = spawn('docker', ['exec', '-i', '--', name(id), 'bash', '-c',
                `set -e; temp=$(mktemp -- "$(dirname -- "$1")/.write.XXXXXX"); trap 'rm -f -- "$temp"' EXIT; cat > "$temp"; mv -T -- "$temp" "$1"`,
                'save', file], { stdio: ['pipe', 'ignore', 'ignore'], timeout: 30_000, windowsHide: true });
            process.on('error', reject);
            process.stdin.on('error', reject);
            process.on('close', code => code === 0 ? resolve() : reject(new Error('Could not save the desktop file')));
            process.stdin.end(data);
        });
    },
    async download(id, file) {
        const { stdout } = await command(id, ['bash', '-c',
            'root=$(realpath -e -- "$1") && file=$(realpath -e -- "$2") && [[ "$file" == "$root/"* && -f "$file" ]] && head -c 16777217 -- "$file"',
            'download', `/workspace/files/${id}`, file]);
        if (stdout.length > 16 * 1024 * 1024)
            throw new Error('File exceeds the 16 MiB download limit');
        return stdout;
    },
};
//# sourceMappingURL=desktop.js.map
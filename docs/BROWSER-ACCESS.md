# Browser access from a second laptop

The Marion Agent Mac app already runs a backend and owns the workspace in SQLite. An authenticated HTTPS proxy gives the second laptop the same workspace in a normal browser. The Mac must stay awake, online, and running Marion Agent. The iPhone can keep using its existing Tailscale link. A hosted database would leave the Mac responsible for any local models, desktops, or agent CLI accounts.

## Set up a stable HTTPS address

Use a named Cloudflare Tunnel with Cloudflare Access if the intended browser and school network permit the hostname. A published application needs an active domain on Cloudflare and an account that can create Access applications and tunnels. The laptop signs in in its browser. Only the Mac runs `cloudflared`. [Cloudflare setup requirements](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)

1. Choose a subdomain on that domain, such as `marion.example.com`. In Cloudflare Zero Trust, create a self-hosted Access application for the entire hostname. Set an **Allow** policy for your own email address with your chosen identity provider and no bypass policy. [Cloudflare Access setup](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
2. Create a named tunnel and run its connector on the Mac. Add a published route for the hostname to `http://127.0.0.1:8789`. Set **HTTP Host Header** to the same hostname and enable **Protect with Access** for the application. Keep the Mac server on its existing loopback port. [Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/) · [Origin parameters](https://developers.cloudflare.com/tunnel/reference/origin-parameters/)
3. On the Mac, use **Marion Agent → Open App Data Folder**, then open Terminal in that folder. Run the following command with your exact HTTPS address. It creates `browser-pairing.json` with a random passphrase and owner-only file permissions. It preserves an existing file.

   ```sh
   '/Applications/Marion Agent.app/Contents/Resources/runtime/node' -e '
     const { randomBytes } = require("node:crypto");
     const { writeFileSync } = require("node:fs");
     const address = new URL(process.argv[1]);
     if (address.protocol !== "https:" || address.origin !== process.argv[1]) {
       throw new Error("Use the exact HTTPS origin without a trailing slash.");
     }
     const pairing = { origin: address.origin, passphrase: randomBytes(24).toString("base64url") };
     writeFileSync("browser-pairing.json", JSON.stringify(pairing, null, 2) + "\n", { mode: 0o600, flag: "wx" });
   ' 'https://marion.example.com'
   ```

4. Quit and reopen Marion Agent. In **Settings → General → Browser access**, reveal the separate browser passphrase. On the second laptop, visit the HTTPS address, sign in to Cloudflare Access, and enter the Marion passphrase. Verify that a signed-out browser first lands at Cloudflare Access. Marion then requires pairing before it serves the workspace API.

Marion browser sessions last eight hours. Sign out from the account menu when done. To revoke browser sessions, replace the passphrase in `browser-pairing.json` and restart Marion. To disable the route, remove the published hostname from the tunnel and remove `browser-pairing.json`. Neither action affects the iPhone link.

## Use a different authenticated HTTPS proxy

The Mac accepts an opt-in browser origin with its own passphrase. A compatible proxy preserves the configured `Host`, sets `X-Forwarded-Proto: https`, and forwards streaming responses and WebSocket upgrades. For a Mac build configured through environment variables, the same options are `MARION_BROWSER_ORIGIN` and `MARION_BROWSER_PASSPHRASE`. Use the exact HTTPS origin without a path or trailing slash and a random passphrase of at least 24 characters. The browser origin and passphrase must differ from the iPhone configuration.

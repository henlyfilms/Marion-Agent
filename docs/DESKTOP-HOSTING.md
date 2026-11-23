# Desktop hosting options

| Option | What it supplies | Cost and limits |
| --- | --- | --- |
| Existing Windows PC with WSL 2 and Docker | One Linux desktop per bot, including Chromium, a shell, a Library, and a viewer | No cloud VM fee. Requires an eligible Docker Desktop license, local CPU, RAM, disk, and power. |
| Existing Linux PC or spare mini PC with Docker Engine | The same desktops on an always-on box you manage | No cloud VM fee. You're responsible for power, updates, and remote access. |
| Oracle Cloud Infrastructure Always Free | A Linux host on which to install Docker and run the same app and desktop image | Check the current Always Free shape, home-region capacity, core, memory, storage, and idle-reclamation rules before relying on it. CPU architecture matters. Ampere instances require an ARM64-compatible Node release and desktop build. OCI was not provisioned or tested for this project. |
| Android Emulator | An Android environment for mobile workflows | Requires a different driver, an Android system image, and preferably hardware virtualization. It is a future integration. |
| Apple Simulator or physical iPhone | iOS testing on a Mac or actual device | Apple Simulator requires macOS and Xcode. A physical iPhone adds hardware and a device automation bridge. Neither is supported by the Linux desktop driver. |

The recommended starting point is the existing Windows PC. Establish the local workflow and size it using real workloads. For always-on service, a spare Linux PC or eligible OCI Linux VM can run the same architecture. Keep desktop connections private. If you need remote access, use a private access layer and configure application authentication before allowing Internet traffic.

The Docker image supplies Linux desktops. Windows-specific desktop applications would need a separate Windows VM or physical PC integration with its own license and automation interface.

Docker’s Windows installation guide and Microsoft’s WSL documentation were verified from their official source repositories. Direct access to Oracle’s Free Tier pages was blocked in the cloud environment, so current quotas and availability could not be confirmed.

- [Oracle Cloud Free Tier documentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm)
- [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/)
- [Microsoft WSL installation](https://learn.microsoft.com/windows/wsl/install)
- [Docker Desktop licensing](https://docs.docker.com/subscription/desktop-license/)
- [Android Emulator](https://developer.android.com/studio/run/emulator)
- [Apple Simulator and device documentation](https://developer.apple.com/documentation/xcode/running-your-app-in-simulator-or-on-a-device)

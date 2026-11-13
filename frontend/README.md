# Scaffold frontend

**Status:** helper integrasi tersedia; aplikasi, viem client, MetaMask connector, dan runtime UI masih **Planned**. Tidak ada package atau command startup.

Tanggung jawab target: patient consent, permintaan break-glass, status transaksi pending/final/reverted, expiry, dan riwayat audit. UI tidak memutuskan sendiri kebenaran emergency atau membuka akses tanpa gateway.

**Input:** wallet MetaMask, RPC publik development, manifest deployment 1337, ABI, event/status kontrak. **Output:** transaksi bertanda tangan dan tampilan status; tidak ada private key atau ciphertext key dalam konfigurasi browser.

`integration.ts` menyediakan guard dependency-free untuk manifest dan chain ID. Konsumsi publik yang direncanakan: ambil `smart-contract/deployments/1337.json` dan ABI terkait dari `smart-contract/abi/` saat build, validasi JSON melalui helper, lalu periksa `eth_chainId` wallet dan chain ID RPC sebelum membuat client kontrak. Artifact tersebut belum tersedia. Ulangi pemeriksaan ketika jaringan berubah dan sebelum aksi; lakukan verifikasi deployment/ABI tambahan dengan viem setelah tooling tersedia.

Jangan bundle deployment, oracle, gateway, atau encryption secrets; jangan mengimpor root `.env`. Lihat [kontrak integrasi](../docs/integration-contract.md) untuk format manifest dan batas validasi. Berikutnya: tunggu chain/manifest/ABI Role 1/2, pilih dan pin tooling UI/viem, kemudian implementasikan wallet dan alur use-case. Scaffold bukan dApp yang sudah berfungsi.

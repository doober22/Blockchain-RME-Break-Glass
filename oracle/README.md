# Scaffold oracle

**Status:** kontrak tipe response dan rancangan alur tersedia; worker, HTTP server/client, signer, checkpoint, dan runtime validation masih **Planned**. Tidak ada package atau command startup.

**Tanggung jawab:** verifikasi konteks emergency melalui API fasilitas sintetis yang dikelola independen dari input dokter. Pernyataan emergency dokter di frontend tidak cukup untuk approval.

**Input:** event final `EmergencyRequested`, detail request dari kontrak, manifest/ABI, konfigurasi fasilitas tepercaya, dan response mock API. **Output target:** transaksi `resolveEmergency` dari akun oracle berwenang, receipt/status final, serta log/checkpoint tanpa secret atau bukti klinis mentah.

Alur target: event final → ambil detail request → `GET /api/v1/encounters/{encounterId}/emergency-context` → validasi schema, autentikasi, binding, dan freshness → keputusan terikat request → transaksi → cek receipt final. Endpoint ini mock proyek, bukan API SATUSEHAT. Gunakan data sintetis saja.

`emergency-context.ts` hanya mendefinisikan tipe handoff, bukan schema validator. Authenticated API access, timeout/retry terbatas, fail-closed handling, request binding, idempotency, dan pemulihan checkpoint belum diimplementasikan. Secret oracle hanya di trusted worker environment, terpisah dari frontend dan deployer.

Berikutnya: Role 1 menyediakan chain/finality dan endpoint container; Role 2 menyediakan kontrak deployable, event/getter scope, artifact, dan hash encoding. Implementer worker kemudian memasang viem dan runtime schema validation berdasarkan [kontrak integrasi](../docs/integration-contract.md).

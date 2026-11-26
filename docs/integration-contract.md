# Kontrak integrasi antarkomponen

Dokumen ini mencatat implementasi infrastruktur/kontrak saat ini serta rancangan layanan yang masih Planned.

## Network, environment, dan artifacts

| Item | Kesepakatan dan kondisi |
| --- | --- |
| Chain ID | 1337; wallet JSON-RPC 0x539. Tooling menolak chain ID lain. |
| Host RPC | http://127.0.0.1:8545, namespace ETH/NET/WEB3, loopback host. |
| Container RPC | http://rpc:8545 pada network rme-break-glass_chain; bukan localhost milik container oracle. |
| Environment bersama | BESU_CHAIN_ID, BESU_RPC_URL, DEPLOYER_PRIVATE_KEY. Root .env dibuat oleh init jika perlu; key hanya di trusted environment. |
| Scripts kontrak | compile, test, deploy:besu, export:abi, typecheck, deployer:address tersedia. Root mendelegasikan melalui contracts:*. |
| Address manifest | smart-contract/deployments/1337.json, dihasilkan deployment yang terverifikasi. |
| ABI | smart-contract/abi/ParticipantRegistry.json dan MedicalAccessController.json, masing-masing ABI array publik. |
| Onboarding | Operator stop → approve address di kelima node → start/health → fund. Role registry terpisah. |

Manifest schemaVersion 1 berisi chainId, genesisHash, deployer, initialAdmin, contracts.ParticipantRegistry, contracts.MedicalAccessController, deploymentTransactions yang dipetakan ke hash transaksi per nama kontrak, serta artifactHashes. Format ini sekarang dikirim Role 2; lihat [spesifikasi deployment](../smart-contract/deployments/README.md). Jangan menganggap schema masih belum ditentukan.

Frontend hanya boleh menyalin manifest publik dan dua ABI ke build assets. Helper frontend memeriksa chain ID wallet/RPC dan address nonzero; deploymentTransactions pada tipe scaffold masih unknown sehingga belum memvalidasi schema baru secara lengkap. Integrasi viem berikutnya harus memvalidasi schemaVersion, hash, receipt, code, dan kesesuaian artifact. Ulangi guard saat chainChanged, perubahan RPC, serta sebelum aksi. Jangan mengimpor root .env, deployment scripts, atau service/encryption secrets ke browser.

## Consent dan authorization normal (implemented; runtime gateway Planned)

Controller source sekarang mengimplementasikan `registerRecord`, `deactivateRecord`, `grantConsent`, `revokeConsent`, `canRead`, dan `authorizeAccess`. Mode publik: `NORMAL_MODE() = 0`, `EMERGENCY_MODE() = 1`. `canRead` mengembalikan false untuk mode emergency sampai kebijakannya diimplementasikan. Manifest 1337 yang tersimpan masih deployment skeleton historis; ABI source terbaru harus dipasangkan dengan deployment baru yang diverifikasi, bukan diasumsikan cocok dengan address lama.

Pasien pemilik record aktif memberi consent untuk satu dokter, satu record, dan expiry Unix seconds di masa depan. Keduanya harus eligible; fasilitas penerbit aktif. Consent normal boleh lintas fasilitas. Pasien asli dapat mencabut consent walaupun kredensial/role-nya sudah tidak aktif. Consent baru mempunyai ID baru; pencabutan tidak menghapus metadata lama.

`canRead(clinician, recordId, mode, grantId)` adalah query publik yang memeriksa policy terkini, bukan bukti penguasaan wallet. Runtime gateway kelak harus memverifikasi challenge wallet dokter, memeriksa query, lalu mengirim `authorizeAccess` sebagai gateway eligible fasilitas penerbit record. Kontrak memeriksa ulang policy saat eksekusi; query true tidak menjamin transaksi berikutnya berhasil. Expiry bersifat eksklusif: akses ditolak pada `block.timestamp >= expiresAt`.

`accessId` harus bytes32 nonzero baru untuk setiap otorisasi dan unik lintas record/grant/gateway dalam satu instance controller. Hanya transaksi sukses yang memakai ID dan emit `AccessAuthorized`; transaksi gagal tidak meninggalkan event. Setelah receipt final sukses, gateway tetap harus memeriksa ulang status terkini, menguji ciphertext, dan mencatat outcome pengiriman off-chain. Implementasi HTTP, wallet challenge, enkripsi, dan delivery log masih Planned. Lihat [panduan kontrak](smart-contracts.md#normal-consent-and-read-authorization) untuk error, policy, dan bukti tes.

## Oracle: event → API → transaksi (Planned)

1. Dengarkan EmergencyRequested(requestId, patient, clinician, facilityId, requestHash, deadline) dari address tervalidasi pada chain 1337. Tunggu blok QBFT yang sudah dikomit dan receipt sukses; implementer harus menguji dukungan RPC finality/tag sebelum mengandalkannya.
2. Baca getRequest(requestId), periksa exists, lalu ambil/validasi record scope melalui mekanisme yang disepakati Role 2. Getter metadata sekarang tersedia, tetapi mutasi request masih stub dan belum ada getter daftar record. Event tidak membawa encounter ID maupun record list.
3. Query mock hospital API berdasarkan encounter dari sumber fasilitas tepercaya. API dikelola independen dari input dokter; jangan memakai URL bebas dari pemohon.
4. Validasi schema, autentikasi, freshness, serta binding pasien, dokter, fasilitas, encounter, evidence commitment, request hash, chain ID, dan contract address. Request harus pending/belum deadline, kredensial aktif, dan semua indikator emergency yang diwajibkan benar.
5. Kirim resolveEmergency(uint256 requestId, bool approved, bytes32 requestHash, uint64 observedAt, uint64 validUntil) melalui akun oracle berwenang, lalu periksa receipt final. Metode masih NotImplemented(); approval HTTP bukan grant on-chain.

### Mock endpoint proyek

GET /api/v1/encounters/{encounterId}/emergency-context adalah **rancangan mock API proyek**, bukan endpoint SATUSEHAT. Semua data sintetis. Tipe di oracle/emergency-context.ts bukan runtime validator atau server.

| Field | Bentuk yang diusulkan | Makna |
| --- | --- | --- |
| encounterId | string hex bytes32 | ID encounter acak; cocok dengan path dan request. |
| patientWallet | string address EVM | Pasien dalam request. |
| clinicianWallet | string address EVM | Dokter pemohon. |
| facilityId | string hex bytes32 | Fasilitas pemohon. |
| encounterActive | boolean | Encounter masih berlangsung. |
| emergency | boolean | Konteks darurat dari fasilitas. |
| patientUnableToConsent | boolean | Pasien tidak mampu memberi consent. |
| clinicianAssigned | boolean | Dokter ditugaskan pada encounter. |
| evidenceCommitment | string hex bytes32 | Komitmen bukti sintetis, cocok dengan request. |
| observedAt | integer Unix seconds | Waktu observasi, bukan milliseconds. |
| validUntil | integer Unix seconds | Batas validitas observasi. |

### Persyaratan worker berikutnya

Semua hal berikut masih Planned: runtime schema validation; authenticated API access dan transport aman di luar localhost; binding fasilitas; waktu bukan dari masa depan; usia/validity window maksimal 60 detik; request deadline 120 detik; serta canonical request/attestation encoding yang dikonfirmasi Role 2.

Timeout, response rusak/usang, mismatch, atau sumber tidak terautentikasi tidak boleh menghasilkan approval. Retry harus terbatas oleh jumlah/waktu/deadline. Checkpoint dan idempotency memakai chain, contract, request, serta event identity; cek status on-chain sebelum retry setelah crash atau receipt tidak pasti. Kontrak tetap perlu menolak keputusan ganda.

## Handoff berikutnya

**Role 1:** command lifecycle, onboarding, host/container RPC, reset recovery, dan hasil penerimaan tersedia pada [panduan chain](private-chain.md). Allowlists jaringan bukan role aplikasi.

**Role 2:** selesaikan operasi medis controller, verifikasi request scope, dan canonical hashes. Registry, constructors/getter metadata, tests, signer, manifest schema, serta ABI exporter sekarang tersedia.

**Role 3/implementer layanan:** integrasikan manifest schema baru, wallet/viem, worker dengan runtime validation/checkpoints, gateway, encrypted storage/key service, indexer/notifikasi, dan demo use-case. Semua komponen tersebut tetap Planned sampai implementasi serta pengujiannya tersedia.

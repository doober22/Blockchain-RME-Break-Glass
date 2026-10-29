# Blockchain RME Break-Glass

Prototipe dApp untuk mengelola persetujuan pasien dan akses darurat (break-glass) terhadap Rekam Medis Elektronik (RME). Pasien dapat memberikan dan mencabut consent normal. Dokter dapat meminta akses darurat terbatas setelah oracle memverifikasi konteks darurat dari API fasilitas. Blockchain menyimpan metadata minimum, kebijakan akses, dan event audit; RME terenkripsi serta kunci tetap berada di luar blockchain. Prototipe menggunakan data sintetis.


## Struktur repository

```text
frontend/                  # Antarmuka TypeScript, viem, dan MetaMask
smart-contract/            # Kontrak Solidity dan tooling Hardhat
  contracts/               # ParticipantRegistry dan MedicalAccessController
  scripts/                 # Skrip deployment dan seed
  test/                    # Pengujian kontrak
  hardhat.config.ts
  package.json
oracle/                    # Worker verifikasi konteks darurat dari API fasilitas
docs/                      # Arsitektur, deployment, evaluasi, laporan, user guide
LICENSE
README.md
```

## System requirements

- Node.js 24 LTS dan npm untuk pengembangan TypeScript/Hardhat.
- Docker Engine atau Docker Desktop dengan Docker Compose untuk rencana jaringan Besu.
- Browser dengan MetaMask untuk interaksi pengguna.
- RPC HTTP ke private chain Besu untuk integrasi kontrak dan layanan.

## Setup tooling kontrak

Dari root repository:

```sh
cd smart-contract
npm install
npm run compile
```

## Deployment smart contract pada private chain

Belum tersedia.

## Deployment dan integrasi oracle

Belum tersedia.

## Lisensi

MIT; lihat [LICENSE](LICENSE).

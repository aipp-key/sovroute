# 📦 SovRoute-Box: Bağımsız Operatör & Düğüm El Kitabı (Runbook)

Bu doküman, aktivistlerin, bağımsız node operatörlerinin ve yerel toplulukların üçüncü şahıslara ve merkezi takas borsalarına bağımlı kalmadan kendi **SovRoute Egemen Takas Düğümünü (Sovereign Node)** kurmaları ve yönetmeleri için hazırlanmış resmi operasyonel kılavuzdur.

---

## 🖥️ 1. Donanım & Sistem Gereksinimleri

SovRoute-Box, düşük kaynak tüketimi ve yüksek güvenlik için budanmış (pruned) Bitcoin Core ve hafif multi-stage Docker konteynerleri kullanır.

| Bileşen | Minimum Gereksinim | Önerilen (Prodüksiyon) |
| :--- | :--- | :--- |
| **İşlemci (CPU)** | 4 vCPU (x86_64 veya ARM64) | 8-16 vCPU (Hızlı IBD için) |
| **Bellek (RAM)** | 8 GB RAM | 16 GB - 32 GB RAM |
| **Depolama (Disk)** | 100 GB SSD/NVMe | 250 GB+ NVMe SSD |
| **İşletim Sistemi** | Ubuntu 24.04 LTS / Debian 12 | Ubuntu 24.04 LTS |
| **Ağ Bağlantısı** | 50 Mbps Kesintisiz Genişbant | 1 Gbps Simetrik Bağlantı |
| **Örnek Cihazlar** | Hetzner CX32, Raspberry Pi 5 (8GB) | Hetzner CX42 / CX53, Dedicated Bare-Metal |

> [!NOTE]
> **Disk Tüketimi Dağılımı:**
> * Budanmış (Pruned) Bitcoin Core: **~57.6 GB** (`prune=55000`)
> * LND ve Zincir Veritabanı: **~5-10 GB**
> * SovRoute SQLite WAL Veritabanı: **<1 GB**
> * İşletim Sistemi ve Docker İmajları: **~10-15 GB**
> * Toplam Gerekli Alan: **~85-100 GB**

---

## 🔒 2. Güvenlik Mimarisi & Ağ İzolasyonu

Sistem iki adet tamamen yalıtılmış sanal ağ üzerinden haberleşir:

```
[ İnternet / Base L2 RPC ]
         │
         ▼ (HTTPS)
┌────────────────────────────────────────────────────────┐
│  Konteyner: sovroute-router (UID 2100)                 │
│  - Swap API & Watcher Servisi                          │
│  - Port 3000 (Dışa açık)                               │
└─────────────────────────┬──────────────────────────────┘
                          │ (sovereign_router_net: 10.240.20.0/24)
                          ▼ (REST :8080)
┌────────────────────────────────────────────────────────┐
│  Konteyner: sovereign-lnd (UID 2102) [DUAL-HOMED]      │
│  - Lightning Düğümü (Port 9735 dışa kapalı - Mode A)   │
│  - Sadece fatura okuma/yazma kısıtlı macaroon          │
└─────────────────────────┬──────────────────────────────┘
                          │ (sovereign_chain_net: 10.240.10.0/24 - DAHİLİ)
                          ▼ (RPC :8332, ZMQ :28332/28333)
┌────────────────────────────────────────────────────────┐
│  Konteyner: sovereign-bitcoind (UID 2101)              │
│  - Cüzdansız (disablewallet=1), Giden-yalnızca         │
│  - router_net'e ASLA BAĞLANAMAZ                        │
└────────────────────────────────────────────────────────┘
```

---

## 🚀 3. Üç Adımda Kurulum & Başlatma

### Adım 1: Dizin Yapısını & İzinleri Hazırlama
Sunucuda root veya `sudo` yetkisiyle dizinleri açın ve konteyner kullanıcılarına izin verin:

```bash
# 1. Dizinleri oluştur
sudo mkdir -p /srv/sovereign-router/{bitcoin,lightning,router,config,secrets}

# 2. Ayrılmış UID'leri ata (En düşük yetki prensibi)
sudo chown -R 2101:2101 /srv/sovereign-router/bitcoin
sudo chown -R 2102:2102 /srv/sovereign-router/lightning
sudo chown -R 2100:2100 /srv/sovereign-router/router
sudo chown -R 2100:2100 /srv/sovereign-router/secrets

# 3. İzinleri sıkılaştır
sudo chmod 700 /srv/sovereign-router/secrets
sudo chmod 750 /srv/sovereign-router/lightning
```

### Adım 2: Yapılandırma Dosyalarını Oluşturma

1. **Bitcoin Core Yapılandırması (`/srv/sovereign-router/config/bitcoin.conf`):**
```ini
server=1
listen=0
disablewallet=1
prune=55000
dbcache=2048
rpcbind=10.240.10.2
rpcallowip=10.240.10.0/24
zmqpubrawblock=tcp://10.240.10.2:28332
zmqpubrawtx=tcp://10.240.10.2:28333
# rpcauth üretimi için: python3 share/rpcauth/rpcauth.py sovereign_user <password>
rpcauth=sovereign_user:salt$hash
```

2. **Ortam Değişkenleri Şablonunu Kopyalama:**
```bash
cp deploy/.env.box.example deploy/.env.box
# deploy/.env.box dosyasını düzenleyerek kendi RPC ve anahtar bilgilerinizi girin:
nano deploy/.env.box
```

### Adım 3: Düğümü Başlatma & Blok Senkronizasyonu (IBD)

```bash
# Düğümü arka planda başlat
docker compose -f deploy/docker-compose.box.yml --env-file deploy/.env.box up -d

# Bitcoin Core blok indirme durumunu izle (initialblockdownload kontrolü)
docker exec -it sovereign-bitcoind bitcoin-cli -conf=/etc/bitcoin/bitcoin.conf getblockchaininfo
```

> [!IMPORTANT]
> `initialblockdownload` değeri `false` olana ve blok yüksekliği güncel ağ ucuyla eşitlenene kadar LND üzerinde işlem yapmayın.

---

## 🔐 4. LND Cüzdan Başlatma & Fiziksel Soğuk Depolama

Bitcoin Core senkronizasyonu bittikten sonra LND cüzdanını başlatın:

```bash
# 1. Etkileşimli cüzdan oluşturma
docker exec -it sovereign-lnd lncli create

# 2. Şifre belirleyin ve ekranda beliren 24 kelimelik Aezeed tohumunu (seed)
# ASLA bir dosyaya kaydetmeyin, sunucuda bırakmayın veya kopyalamayın.
# Kağıda veya metal plakaya yazarak fiziksel kasaya kaldırın!

# 3. SovRoute Router için kısıtlı macaroon üretin (Para çekme ve gönderme YASAKLANIR):
docker exec -it sovereign-lnd lncli bakemacaroon \
  --save_to=/data/.lnd/router-restricted.macaroon \
  invoices:read invoices:write info:read

# 4. Kısıtlı macaroon ve TLS sertifikasını router sır dizinine kopyalayın:
sudo cp /srv/sovereign-router/lightning/router-restricted.macaroon /srv/sovereign-router/secrets/
sudo cp /srv/sovereign-router/lightning/tls.cert /srv/sovereign-router/secrets/lnd-tls.cert
sudo chown 2100:2100 /srv/sovereign-router/secrets/*
sudo chmod 600 /srv/sovereign-router/secrets/*
```

---

## 📊 5. Sağlık Takibi & Teşhis Komutları

```bash
# Konteyner durumları ve RAM/CPU tüketimi
docker stats --no-stream

# SovRoute Router API ve Watcher durumunu sorgulama
curl -s http://localhost:3000/api/health | jq

# LND zincir senkronizasyon kontrolü
docker exec -it sovereign-lnd lncli getinfo | jq '{synced_to_chain, block_height, num_peers}'

# Watcher loglarını canlı izleme
docker logs -f sovroute-router
```

---

## 🛑 6. Acil Durum Kapatma (Fail-Closed Halt)

Herhangi bir şüpheli işlem veya güvenlik alarmında düğümü güvenle durdurun:

```bash
# Sadece Router servisini dondurma (Havada kalan fonlar timelock ile güvendedir)
docker compose -f deploy/docker-compose.box.yml stop sovroute-router

# Tüm düğümü tamamen durdurma
docker compose -f deploy/docker-compose.box.yml down
```

> [!TIP]
> **Atomik Güvenlik İlkesi:**
> Router servisi durdurulsa dahi, Base L2 üzerindeki USDC HTLC'si timelock süresi dolduğunda operatöre iade edilebilir; Lightning Hold Invoice ise süresi dolunca otomatik iptal olarak kullanıcıya geri döner. Sıfır fon kaybı prensibi donanım kapanmalarında da korunur.

---

## 💾 7. Yedekleme & Felaket Kurtarma

### 1. SovRoute Veritabanı (SQLite WAL Yedekleme)
```bash
# Canlı veritabanını bozmadan güvenli anlık yedek alma:
sqlite3 /srv/sovereign-router/router/router.sqlite ".backup '/backup/router-$(date +%F).sqlite'"
```

### 2. LND Statik Kanal Yedeklemesi (SCB)
Her yeni kanal açılışında veya kapanışında LND otomatik olarak statik kanal yedek dosyasını günceller:
```bash
# Bu dosyayı güvenli bir uzak sunucuya veya şifreli ortama yedekleyin:
/srv/sovereign-router/lightning/data/chain/bitcoin/mainnet/channel.backup
```

# Schema export `tamper-ads/2`

Contratto di dati tra **tamper-ads** (raccolta dall'Ad Library) e **social-business-manager** (validazione e crescita).
Lo userscript produce due file con lo stesso nome base: `meta-ads-<paese>-<data>.csv` e `.json`.

- **CSV**: piatto, retrocompatibile (le prime 21 colonne sono quelle della v5). Liste separate da ` | `.
- **JSON**: stessi dati + `signals` per ogni ad + `groups` (un gruppo = stessa landing, o stessa pagina se manca la landing).
- Chiave primaria: `library_id`. Chiave di raggruppamento creativo: `signals.copy_fingerprint` + `page_id`.
- Gli ad raccolti con versioni precedenti restano nel database locale ma non hanno i campi nuovi finché non vengono rivisti con uno scan (AVVIA o SCAN).

## Campi raccolti dal payload Meta (`ads[]`)

| Campo | Contenuto |
|---|---|
| `library_id`, `page_id`, `page_name` | Identificativi |
| `is_active`, `start_date`, `end_date`, `days_active` | Vita dell'ad. Per gli ad attivi `end_date` è il giorno corrente, non una chiusura vera |
| `display_format` | `IMAGE`, `VIDEO`, `CAROUSEL`, `DPA` (catalogo dinamico), ... |
| `platforms` | `FACEBOOK`, `INSTAGRAM`, `AUDIENCE_NETWORK`, `THREADS`, `MESSENGER` |
| `body`, `title`, `link_description`, `caption`, `cta`, `cta_type` | Testi. Con `DPA` il `title` è spesso un template `{{product...}}` |
| `landing_url` | URL di destinazione |
| `card_count`, `cards[]` | Carosello/catalogo: `title`, `link_url`, `cta_type` di ogni card (max 8). I titoli delle card sono i prodotti/varianti pubblicizzati |
| `image_count`, `video_count`, `image_url`, `video_hd_url`, `video_sd_url`, `video_preview_url`, `media_url` | Asset. **Gli URL scadono dopo pochi giorni** (vedi `signals.media_expires_at`): scaricare subito se servono |
| `page_like_count`, `page_categories`, `page_profile_uri` | Dati della pagina inserzionista |
| `byline`, `disclaimer_label`, `branded_content`, `is_reshared`, `ai_generated`, `page_is_deleted` | Trasparenza: chi paga, partnership con creator, contenuto creato con AI |
| `collation_id`, `collation_count`, `total_active_time` | Raggruppamento varianti e tempo attivo, quando Meta li valorizza (spesso vuoti) |
| `reach_estimate`, `spend`, `currency`, `reached_countries` | Quasi sempre vuoti per ad commerciali: Meta non pubblica la spesa |
| `country`, `keyword`, `countries_seen`, `keywords_seen`, `observed_dates`, `source`, `first_seen`, `last_seen`, `ad_library_url` | Provenienza e osservazioni |

## Segnali derivati (`signals`, colonne in coda al CSV)

Calcolati all'export dal testo e dalla landing: sono euristiche, vanno verificate sui casi dubbi.

| Segnale | Significato |
|---|---|
| `hook` | Prima frase del copy (max 140 caratteri) |
| `word_count`, `emoji_count`, `hashtag_count`, `mention_count`, `ugc_style` | Stile del copy; `ugc_style` = hashtag o @menzioni |
| `has_offer`, `offer_percent`, `offer_amount`, `offer_threshold`, `discount_code`, `free_shipping`, `urgency` | Meccanica dell'offerta. `discount_code` si legge anche da `/discount/CODICE` nella landing |
| `has_review`, `star_count`, `has_checklist` | Prova sociale (stelle o citazione firmata) e elenco di benefit con spunte |
| `is_dynamic_template` | Titolo/testo con placeholder `{{...}}` (catalogo dinamico) |
| `copy_fingerprint`, `copy_variants` | Hash di testo+titolo+CTA+landing e quanti ad della stessa pagina lo condividono. Molte varianti = creatività scalata |
| `landing_host`, `landing_path`, `landing_has_utm` | Destinazione |
| `age_bucket`, `survivor_30d` | Fascia di età (`0-2`, `3-14`, `15-30`, `31-60`, `61+`) e se è attivo da almeno 30 giorni |
| `media_expires_at` | Scadenza del link CDN dell'asset |

## `groups[]` (solo JSON)

`key`, `display_name`, `score`, `label` (`FORTE`/`INTERESSANTE`/`WATCH`/`BASSO`), `score_parts`, `ads_count`, `distinct_copies`,
`oldest_days`, `formats`, `platforms`, `offers`, `discount_codes`, `ads_with_review`, `ads_with_video`, `ads_ugc_style`,
`page_ids`, `page_like_count`, `landing_urls`, `countries`, `observed_dates`, `library_ids`.

Lo `score` è una priorità di ispezione, non una probabilità di vendita.

## Limiti noti

- Meta non espone spesa, impression né performance per gli ad commerciali: `days_active` e `copy_variants` sono proxy.
- Nel carosello i campi per card sono ridotti per non saturare `localStorage`.

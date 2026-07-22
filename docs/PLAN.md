# Plan : EU-Sovereign Investigation Platform — v1.1 Pilot-Ready

> PRD source : `PRD-v1.1-pilot-ready.md`

## Note de cadrage

Le PRD liste B1–B8 (bloquant) et N1–N6 (non-bloquant) comme travail restant pour v1.1. Une
relecture du code et de `DECISIONS.md` montre qu'une bonne partie est déjà livrée depuis la
rédaction du PRD :

- **Déjà fait** : B1 (rowCount check sur merge), B2 (RLS `resolution_queue` hérite de la
  classification), B3 (fan-out cap + BFS bidirectionnel sur `/graph/expand` et `/graph/path`),
  B4 (load-test 1M objets/5M edges publié), B5 (matching trigram via l'opérateur `%`),
  B8 (pipeline CI GitHub Actions), N1/N2/N3 (purpose-of-use admin, avant/après en audit,
  gel des cases closes). Voir décisions #31–#38, #43–#45.
- **Reste ouvert, couvert par ce plan** : B6, B7, N4, N5, N6.
- **Hors plan** : P1–P7 (recrutement partenaires, DPA/DPIA, ISO 27001, pentest, etc.) —
  le PRD lui-même les qualifie de piste parallèle non-technique (§5).

Ce plan ne couvre donc que le travail d'ingénierie réellement restant, pas la séquence §8 du PRD
telle qu'écrite (qui suppose B1–B5/B8 encore à faire).

## Décisions architecturales

Décisions durables qui s'appliquent à toutes les phases :

- **Routes** : les nouvelles routes s'intègrent dans la structure REST existante sous `/api`
  (fichiers par domaine dans `api/src/routes/` — `cases/`, `graph.ts`, `ingestion.ts`, `admin.ts`,
  etc.), pas de style d'API parallèle.
- **Schema** : toute extension de schéma reste compatible avec le modèle RLS existant (rôle
  dédié `app_user`, policies basées sur `classification`/`clearance`, audit hash-chaîné
  append-only).
- **Auth** : split AuthN (Keycloak) / AuthZ (`app_users`) conservé ; toute action sensible
  continue d'exiger un purpose-of-use explicite, sur le modèle déjà en place pour l'admin (#33).
- **Pipeline d'ingestion** : le chunking par transactions de 500 lignes avec checkpointing et
  reprise après crash (décisions #37, #38) reste la base — le travail d'ingestion asynchrone
  (Phase 1) s'ajoute par-dessus, ne remplace pas ce mécanisme.
- **Cible de déploiement** : un environnement EU-hosted unique (pas multi-région, pas on-prem)
  — hypothèse posée en attendant la réponse à la question ouverte #2 du PRD (cloud EU vs
  on-prem).

---

## Phase 1 : Pipeline d'ingestion asynchrone

**User stories** : B6

### Ce qu'on livre

Le dépôt d'un fichier (CSV, potentiellement volumineux — ex. 50k lignes) ne bloque plus la
requête HTTP ni la connexion pool pendant toute la durée du traitement. Le run continue en
arrière-plan sur le mécanisme de chunking/reprise déjà en place ; son statut (en attente / en
cours / terminé / échoué) reste observable de bout en bout via l'UI existante, et d'autres
requêtes continuent d'être servies normalement pendant qu'un gros run tourne.

### Critères d'acceptation

- [x] Le déclenchement d'un run répond immédiatement, sans attendre la fin du traitement de
      toutes les lignes
- [x] Un upload de 50k lignes se termine en arrière-plan ; son statut est observable en continu
      depuis l'UI des runs
- [x] Une requête concurrente sur un autre endpoint est servie normalement pendant qu'un gros run
      est en cours (pas d'épuisement du pool de connexions)
- [x] La reprise après crash (hash de fichier + verrou advisory) continue de fonctionner sans
      régression

**Statut : livré.** Voir `DECISIONS.md` #46. PR #1 (`feat/async-ingestion-pipeline`).

## Bloquée par

- Aucune — démarrable immédiatement

---

## Phase 2 : Ingestion XLSX

**User stories** : N6

### Ce qu'on livre

Un analyste ou admin peut déposer un fichier XLSX dans le même flux d'ingestion (source,
templates de mapping de colonnes, résolution d'entités, quarantaine, reprise) que celui déjà
disponible pour le CSV, sans détour spécifique au format côté UI.

### Critères d'acceptation

- [x] Un upload XLSX se mappe sur les mêmes templates objet/colonne que le CSV
- [x] Une ligne XLSX invalide ou non conforme part en quarantaine comme une ligne CSV
- [x] La reprise après crash fonctionne pour un run XLSX comme pour un run CSV

**Statut : livré.** Voir `DECISIONS.md` #47. Branche `feat/xlsx-ingestion`.

## Bloquée par

- Phase 1 (recommandé — pour ne pas construire XLSX sur l'ancien chemin synchrone et devoir le
  refaire ensuite)

---

## Phase 3 : Application de la rétention

**User stories** : N4

### Ce qu'on livre

Le `retention_days` configuré par source produit un effet réel : les enregistrements dont la
fenêtre de rétention est dépassée sont purgés ou anonymisés automatiquement, selon un cycle
récurrent, et cette action elle-même est auditée.

### Critères d'acceptation

- [x] Un objet/edge dont la fenêtre de rétention de sa source est dépassée est purgé ou anonymisé
      sans intervention manuelle
- [x] L'action apparaît dans le journal d'audit, distincte des actions initiées par un analyste
- [x] Un objet encore dans sa fenêtre de rétention n'est pas touché
- [x] Un admin peut voir quelles sources ont l'enforcement actif et la date de dernière exécution

**Statut : livré (anonymisation via UPDATE, jamais de DELETE — voir `DECISIONS.md` #46).**
Branche `feat/retention-enforcement`.

## Bloquée par

- Aucune — démarrable immédiatement

---

## Phase 4 : Sécurité de type à la frontière API

**User stories** : N5

### Ce qu'on livre

Les formes de requête/réponse entre `web` et `api` sont définies à un seul endroit partagé et
validé, plutôt que supposées indépendamment de chaque côté — un changement de forme casse la
build au lieu de se manifester en `undefined` silencieux à l'exécution.

### Critères d'acceptation

- [x] Au moins un domaine à fort trafic (ex. case workspace ou graph expand) a ses
      requêtes/réponses validées contre un schéma partagé, côté API et côté web
- [x] Un décalage volontairement introduit (champ renommé/supprimé) fait échouer le typecheck ou
      un test, pas seulement l'exécution
- [x] Le pattern est documenté suffisamment pour migrer les routes restantes de façon
      incrémentale sans nouvelle phase de conception

**Statut : livré (`GET /cases/:id` migré, deux bugs réels trouvés en cours de route — voir
`DECISIONS.md` #46).** Branche `feat/api-type-safety`. Le reste des routes n'est pas encore
migré ; `shared/README.md` documente comment le faire.

**Suite incrémentale :** `PATCH /cases/:id/status` migré à son tour (`DECISIONS.md` #51,
branche `feat/close-case-ui`), avec extraction des primitives communes dans
`shared/schemas/common.ts`. Restent prioritaires d'après le backlog : `/graph/expand` et la
liste des cases.

## Bloquée par

- Aucune — démarrable immédiatement

---

## Phase 5 : Déploiement sur hébergeur EU

**User stories** : B7 (partie 1)

### Ce qu'on livre

L'ensemble de la stack (API, web, Postgres, Keycloak) tourne sur une infrastructure EU réelle et
est accessible de bout en bout pour un cycle complet alerte→case→document→clôture, pas
seulement en local via docker compose.

### Critères d'acceptation

- [x] Une instance déployée sur infrastructure EU est accessible, et un cycle complet
      alerte→case→document→clôture s'exécute dessus avec succès
- [x] Les secrets/config de l'environnement déployé sont gérés hors du contrôle de source
- [x] Les étapes de déploiement sont reproductibles depuis la documentation, pas de connaissance
      tribale

**Statut : livré, mais avec une réserve importante à ne pas perdre de vue.** Faute de budget
pour Hetzner (la recommandation initiale), cette phase a été livrée comme une démo éphémère sur
machine personnelle derrière un tunnel Cloudflare — voir `deploy/README.md` et `DECISIONS.md`
#47. Les trois critères ci-dessus sont satisfaits à la lettre (instance EU réellement
accessible publiquement, cycle complet exécuté avec succès, secrets générés hors dépôt,
étapes documentées et reproductibles), mais ce n'est PAS l'infrastructure cloud réelle visée à
l'origine — juste une étape intermédiaire, explicitement documentée comme telle, en attendant
le budget. Trois bugs réels trouvés et corrigés en cours de route (script `start` de l'API
jamais fonctionnel, une quasi-perte de données dev par collision de projet Docker Compose,
Keycloak générant des URLs `http://` derrière le tunnel TLS).

## Bloquée par

- Aucune techniquement — recommandé après la Phase 1 pour ne pas déployer une architecture
  d'ingestion appelée à changer

### Suivi

Le cycle complet exécuté lors de cette phase avait dû être terminé au `curl` : l'application web
n'avait aucun contrôle de clôture de case. Ce trou est fermé depuis (`DECISIONS.md` #51) — le
cycle alerte→case→document→clôture s'exécute désormais intégralement dans le produit, ce que
demande la métrique de succès §6 du PRD. Vérifié en navigateur réel, connexion PKCE comprise.

---

## Phase 6 : Sauvegardes et restauration vérifiée

**User stories** : B7 (partie 2)

> Bloquée en pratique malgré la Phase 5 "livrée" : sauvegarder/restaurer une machine
> personnelle derrière un tunnel éphémère n'aurait aucune valeur représentative pour
> l'infrastructure cloud réelle visée. Attend la vraie migration Hetzner, pas juste la levée
> du blocage formel ci-dessous.

### Ce qu'on livre

Les données de l'environnement déployé sont récupérables : une sauvegarde automatique est en
place, et une restauration a réellement été exécutée une fois — pas seulement documentée en
théorie.

### Critères d'acceptation

- [ ] Une sauvegarde automatisée s'exécute selon un calendrier sur la base de données déployée
- [ ] Un exercice de restauration a été exécuté au moins une fois sur une copie hors production,
      avec résultats documentés
- [ ] Le temps de restauration et la fenêtre de perte de données (RPO) sont énoncés, pas supposés

## Bloquée par

- Phase 5

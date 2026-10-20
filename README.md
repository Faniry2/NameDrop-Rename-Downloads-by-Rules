# Renommeur de téléchargements

Extension Chrome (Manifest V3) qui renomme automatiquement les fichiers téléchargés et déclenche des actions selon des règles personnalisées.

## Fonctionnalités

- **Règles conditionnelles** : filtrer sur le nom, l'extension, le domaine, l'URL, le site d'origine ou le type MIME (contient, est égal à, commence/finit par, regex…).
- **Modèles de nom** avec variables : `{date}_{name}`, `Factures/{yyyy}/{domain}/{name|slug}`… Un `/` crée un sous-dossier.
- **Tables de correspondance** : une ligne par cas (`edf ; Factures/EDF/{date}`), collable depuis Excel.
- **Compteur par règle** (`{n}`, `{n:3}`) avec remise à zéro optionnelle.
- **Demande du nom** au moment du téléchargement, avec suggestions et mémorisation.
- **Actions** : notification, afficher dans le dossier, ouvrir le fichier, ouvrir une URL, webhook (POST JSON), retirer de l'historique, bloquer le téléchargement.
- Page d'options avec testeur de règles et historique des derniers renommages.

## Variables disponibles

| Variable | Description |
|---|---|
| `{name}` | nom d'origine sans extension |
| `{ext}` `{filename}` | extension / nom d'origine complet |
| `{domain}` `{referrer}` `{url}` | domaine du fichier, du site d'origine, URL complète |
| `{date}` `{time}` | `2026-10-11` / `14-32-05` |
| `{yyyy}` `{mm}` `{dd}` `{hh}` `{min}` `{ss}` | morceaux de date |
| `{n}` `{n:3}` | compteur de la règle (`001`, `002`…) |
| `{1}` `{2}`… | groupes capturés par une condition regex |
| `{name\|slug}` | filtres : `lower`, `upper`, `slug`, `trim` (cumulables) |

Dans les actions : `{to}` (nouveau nom), `{rule}`, `{status}`, `{size}`, `{path}`.

## Installation

1. Cloner le dépôt : `git clone https://github.com/Faniry2/renommeur.git`
2. Ouvrir `chrome://extensions` et activer le **mode développeur**.
3. Cliquer sur **Charger l'extension non empaquetée** et sélectionner le dossier du projet.

La page d'options s'ouvre au premier lancement pour créer vos règles.

## Permissions

- `downloads`, `downloads.open` : renommer, ouvrir et afficher les fichiers.
- `storage` : enregistrer les règles, compteurs et l'historique (localement).
- `notifications` : notifications de fin de téléchargement.
- `activeTab` et `<all_urls>` (optionnelle, demandée seulement si besoin).

Aucune donnée n'est envoyée ailleurs, sauf vers les webhooks que vous configurez vous-même.

## Licence

[MIT](LICENSE)

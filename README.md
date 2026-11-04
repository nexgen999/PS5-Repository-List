# PS5 Repository List

Bienvenue sur le dépôt **PS5 Repository List**, une plateforme centralisée et automatisée conçue pour suivre, organiser et présenter les dépôts GitHub essentiels de l'écosystème PS5 (homebrews, émulateurs, outils de développement et utilitaires).

---

## 🌟 Vue d'ensemble du projet

Le projet s'articule autour de plusieurs composants clés :
1. **La configuration des sources (`repos-config.json`)** : La liste brute de vos dépôts classés par catégories et couleurs.
2. **Le script de mise à jour (`update-db.js`)** : Un script automatisé (exécuté localement ou via GitHub Actions) qui interroge l'API GitHub pour récupérer les dernières métadonnées de chaque dépôt (étoiles, dernière version, description, etc.).
3. **La base de données générée (`repos-database.json`)** : Le fichier final enrichi et prêt à être consommé par l'interface.
4. **L'interface Web (`index.html`)** : Le tableau de bord visuel permettant aux utilisateurs de naviguer, trier et rechercher parmi tous les outils répertoriés.
5. **Le gestionnaire de configuration graphique (`tools/config_manager.py`)** : Une application de bureau pour administrer facilement le fichier de configuration sans manipuler directement le JSON.

---

## 📂 Structure du dépôt

```text
├── .github/
│   └── workflows/
│       └── deploy.yml         # Workflow GitHub Actions (mise à jour automatique toutes les heures)
├── json/
│   ├── repos-config.json      # Fichier source contenant la liste des URLs et des catégories
│   └── repos-database.json    # Base de données finale générée et mise à jour automatiquement
├── scripts/
│   └── update-db.js           # Script Node.js de récupération des données GitHub
├── tools/
│   └── config_manager.py      # Application graphique Python (Tkinter) pour gérer la config
├── index.html                 # Interface utilisateur web principale
└── README.md                  # Documentation du projet
```

---

## 💻 Description des composants

### 1. L'interface HTML (`index.html`)
L'interface web sert de vitrine au projet. Elle charge dynamiquement le fichier `repos-database.json` pour afficher :
* Une barre de recherche en temps réel pour filtrer les projets.
* Un affichage par cartes (cards) regroupées par catégories visuelles.
* Des badges pour les étoiles GitHub, les versions, et les liens directs vers les dépôts.
* Un design moderne et responsive (adapté mobile et bureau).

### 2. Les fichiers JSON (`json/`)
* **`repos-config.json`** : C'est le fichier source que vous éditez. Il définit les **catégories** (avec leur identifiant, nom et couleur d'affichage) et la liste des **dépôts** (URL GitHub et catégorie associée).
* **`repos-database.json`** : Généré automatiquement, il contient les informations enrichies (statistiques, derniers commits, releases) prêtes à être affichées par le site web.

### 3. Les scripts et workflows
* **`scripts/update-db.js`** : Script Node.js qui lit le fichier de configuration, interroge l'API GitHub (avec gestion des tokens si nécessaire pour éviter les limites de taux) et met à jour la base de données. Il interroge les dépôts en parallèle (24 requêtes simultanées dans le workflow) et réutilise les README et commits déjà présents dans `repos-database.json` tant que le `pushed_at` d'un dépôt n'a pas changé : ajouter un dépôt à la config ne coûte donc plus un rafraîchissement complet.
* **GitHub Actions (`deploy.yml`)** : Un automatisme configuré pour lancer le script de mise à jour **toutes les heures** de manière autonome. Si des données changent, un commit est automatiquement effectué sur le dépôt. Le lancement manuel accepte l'option `force` (onglet Actions → *Run workflow*) pour ignorer le cache et tout retélécharger.

---

## 🛠️ Utilisation de l'outil de gestion (`tools/config_manager.py`)

Pour vous faciliter la vie et éviter les erreurs de syntaxe dans le fichier JSON, une application de bureau a été placée dans le dossier `tools/`.

### Prérequis
* Python 3 installé sur votre machine.

### Lancement de l'outil
Depuis la racine du projet, lancez la commande suivante :

```bash
python tools/config_manager.py
```

### Fonctionnalités de l'outil :
* **Onglet Catégories** : Ajoutez, modifiez ou supprimez des catégories et personnalisez leur code couleur hexadécimal à l'aide d'un sélecteur visuel.
* **Onglet Dépôts** : Ajoutez de nouveaux liens GitHub, associez-les aux catégories existantes via un menu déroulant, modifiez ou supprimez des entrées en un clic.
* **Sauvegarde centralisée** : Un bouton global permet d'écrire instantanément les modifications dans `json/repos-config.json`.

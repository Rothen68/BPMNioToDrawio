# BPMN vers draw.io

Convertit des diagrammes **BPMN 2.0** créés avec [bpmn.io](https://bpmn.io) (ou Camunda Modeler) en fichiers **.drawio** modifiables, à importer dans SAP LeanIX, Confluence (application draw.io), diagrams.net, etc.

- **Mise en page identique** : positions, tailles, points de cassure des flèches et libellés viennent directement du fichier BPMN.
- **Formes natives draw.io** (bibliothèque « BPMN 2.0 ») : le diagramme reste modifiable dans draw.io.
- **Imbrication respectée** : les couloirs sont dans leur pool, les éléments dans leur couloir ou sous-processus, les événements de bordure sur leur activité. Déplacer un pool déplace son contenu.
- **Sous-processus réduits** : chaque vue détaillée devient une page draw.io. Un clic sur le sous-processus ouvre sa page.
- **Sauvegarde réversible** : le BPMN d'origine est embarqué (compressé) dans le fichier .drawio. Donner ce .drawio à l'outil restitue le .bpmn **à l'octet près**, prêt à être rouvert dans bpmn.io.
- La documentation des éléments devient une infobulle. L'identifiant et le type BPMN de chaque forme sont visibles via *Modifier les données* dans draw.io.

## Application Windows

Une fenêtre permet de choisir (ou glisser-déposer) un ou plusieurs fichiers `.bpmn` et de les convertir en un clic. Les fichiers `.drawio` sont enregistrés à côté des originaux ou dans un dossier au choix.

Si on y dépose un `.drawio` créé par l'outil, il restaure le `.bpmn` d'origine. Un fichier existant n'est jamais écrasé : le résultat s'appelle alors `nom (restauré).bpmn`. d

**Récupérer l'exécutable** : chaque push lance le workflow GitHub Actions *Tests et application Windows*, qui produit l'artefact `BPMN-vers-drawio-windows` contenant :

- `BPMN-vers-drawio-x.y.z-portable.exe` : se lance directement, sans installation (pratique sur un poste sans droits administrateur) ;
- `BPMN-vers-drawio-x.y.z-installation.exe` : installateur classique.

Pousser un tag `v0.1.0` publie ces deux fichiers dans une *Release* GitHub.

> L'exécutable n'est pas signé : au premier lancement, Windows SmartScreen peut afficher « Windows a protégé votre ordinateur ». Il faut cliquer sur *Informations complémentaires*, puis sur *Exécuter quand même*.

**Hors ligne** : l'application n'utilise jamais le réseau. Elle désactive la détection automatique du proxy système (requêtes DNS « WPAD » sous Windows) et refuse toute requête vers autre chose qu'un fichier local. Le test `npm run test:offline` le vérifie à chaque build Windows.

## Ligne de commande

Prérequis : Node.js 20 ou plus récent.

```bash
npm install
npm run convert -- mon-processus.bpmn                 # crée mon-processus.drawio à côté
npm run convert -- dossier/ -o sauvegarde/            # tous les .bpmn d'un dossier
npm run convert -- sauvegarde/mon-processus.drawio    # restaure le BPMN d'origine
```

Lancer l'application de bureau en développement : `npm start`. Lancer les tests : `npm test`.

## Importer le fichier .drawio

- **draw.io / diagrams.net** : *Fichier › Ouvrir* (ou glisser le fichier dans la fenêtre).
- **Confluence (application draw.io)** : insérer un diagramme draw.io, puis *Fichier › Importer depuis › Appareil*.
- **SAP LeanIX** : dans un diagramme libre (*Free Draw*, basé sur draw.io), importer le fichier `.drawio`. L'emplacement exact du menu dépend de la version de LeanIX.

## Éléments pris en charge

| BPMN | draw.io |
|---|---|
| Pools (y compris « boîte noire »), couloirs imbriqués | swimlanes imbriquées |
| Tâches : simple, utilisateur, manuelle, service, envoi, réception, script, règle métier | tâche avec marqueur |
| Boucle, multi-instance parallèle / séquentielle, compensation | marqueurs de boucle |
| Sous-processus développé / réduit, sous-processus événementiel, transaction, ad hoc, activité d'appel | formes BPMN correspondantes |
| Événements de début, intermédiaires (émission / réception), de fin, de bordure (interruptifs ou non) avec message, minuterie, escalade, condition, lien, erreur, annulation, compensation, signal, multiple, parallèle multiple, terminaison | événements BPMN |
| Passerelles exclusive (avec ou sans marqueur), parallèle, inclusive, complexe, basée sur les événements | passerelles BPMN |
| Flux de séquence (par défaut, conditionnel), flux de messages, associations, associations de données | flèches BPMN |
| Objets de données (entrée / sortie / collection), stockages de données, annotations, groupes | formes BPMN |

Les éléments de conversation et de chorégraphie ne sont pas convertis en formes dédiées. Ils apparaissent comme un rectangle en pointillés, et un avertissement est affiché.

## Fonctionnement

- `src/converter.js` lit le BPMN avec [bpmn-moddle](https://github.com/bpmn-io/bpmn-moddle), la bibliothèque officielle de bpmn.io. Il produit ensuite le XML draw.io (mxGraph) à partir de la section graphique `BPMNDiagram`.
- Le BPMN d'origine est stocké dans l'attribut `bpmnSource` de la cellule racine de la première page. draw.io conserve cet attribut quand il réenregistre le fichier, y compris au format compressé.
- `src/files.js` gère les fichiers (choix du sens de conversion selon l'extension, noms de sortie). `bin/bpmn2drawio.js` contient la ligne de commande, `app/` l'application Electron.

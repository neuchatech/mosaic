# Wardrobe Atlas — sprints livrés

La roadmap suit le vrai parcours d’achat : éliminer d’abord les pièces impossibles à acheter, puis rendre la comparaison et la découverte progressivement plus utiles. Les six incréments ci-dessous sont intégrés dans l’application locale au 28 août 2026.

## Sprint 1 — Achetable dans ma taille

- [x] Capturer les tailles actuellement disponibles sur les fiches produit, pas toutes les variantes théoriques.
- [x] Distinguer une disponibilité connue, inconnue ou épuisée.
- [x] Filtrer le board compact sur une taille exacte disponible.
- [x] Afficher les tailles connues directement sur les cartes sans ouvrir le shop.
- [x] Enrichir le catalogue existant avec les fiches détaillées et indiquer la couverture.

Critère de sortie : choisir `M`, `L`, `48` ou une autre taille enregistrée ne laisse que les produits actuellement commandables dans cette taille ; les articles inconnus ne sont jamais présentés comme des correspondances confirmées.

## Sprint 2 — Shortlist et comparaison

- [x] Persister les décisions « gardé », « rejeté » et « possédé » depuis le board.
- [x] Ajouter un board réservé à la shortlist et une comparaison compacte côte à côte.
- [x] Montrer prix, tailles disponibles, matière, retours et raison de la sélection visuelle.
- [x] Empêcher les produits rejetés de réapparaître dans les recherches Codex sauf demande explicite.

Critère de sortie : une session de navigation peut se terminer par une petite shortlist d’achat durable.

## Sprint 3 — Acquisition fiable et fraîcheur

- [x] Ajouter une file d’enrichissement des fiches existantes avec progression, annulation et reprises.
- [x] Enregistrer séparément les dernières vérifications du prix, du stock et des tailles, puis signaler les données périmées.
- [x] Rafraîchir à la demande seulement la shortlist ou les produits visibles.
- [x] Isoler chaque shop dans un adaptateur ; Zalando Suisse est livré et l’import JSON-LD prudent permet d’amorcer un autre shop explicitement choisi avec `--generic`.

Critère de sortie : chaque disponibilité a une date de capture visible et peut être rafraîchie sans rescanner tout le catalogue.

## Sprint 4 — Boucle de styliste agentique

- [x] Permettre à Luna de combiner texte, mood boards, favoris, rejets, références et vêtements possédés.
- [x] Diffuser les articles inspectés et les raisons concises pendant le travail de l’agent.
- [x] Appliquer taille, budget, source et catégorie comme contraintes dures avant le scoring visuel.
- [x] Réinjecter les décisions garder/rejeter dans la sélection suivante.

Critère de sortie : une requête agentique produit une sélection pertinente et achetable, avec une raison pour chaque survivant.

## Sprint 5 — Dressing personnel et planches de tenues

- [x] Importer vêtements possédés et références avec images stockées localement et métadonnées.
- [x] Générer des planches de tenues autour d’un achat potentiel.
- [x] Évaluer la nouveauté et la compatibilité avec ce qui est déjà possédé.
- [x] Identifier les manques du dressing au lieu de classer seulement des pièces isolées.

Critère de sortie : l’app peut dire si un achat ajoute réellement des tenues utiles au dressing.

## Sprint 6 — Échelle et finition

- [x] Rendre progressivement les grands boards et mettre en cache projections, images et planches-contact.
- [x] Ajouter vues sauvegardées, exports locaux, navigation clavier et annulation.
- [x] Couvrir clavier, tactile/mobile, mouvement réduit, erreurs, reprise et données inconnues.
- [x] Ajouter des tests de régression hors ligne pour les tailles Zalando, la file d’acquisition, le catalogue, les médias et le MCP Vision borné.

Critère de sortie : plusieurs milliers de produits restent fluides et les parcours principaux sont robustes.

## Prochaine extension

Le prochain adaptateur suisse reste un choix produit, pas une dette d’architecture : sélectionner le shop cible, enregistrer ses fixtures HTML, puis implémenter ses sélecteurs dans `collector/adapters/` sans modifier la file, le catalogue ou l’interface.

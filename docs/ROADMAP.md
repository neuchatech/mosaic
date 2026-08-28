# Wardrobe Atlas — prochains sprints

La roadmap suit le vrai parcours d’achat : éliminer d’abord les pièces impossibles à acheter, puis rendre la comparaison et la découverte progressivement plus utiles. Chaque sprint doit livrer un incrément local utilisable.

## Sprint 1 — Achetable dans ma taille

- Capturer les tailles actuellement disponibles sur les fiches produit, pas toutes les variantes théoriques.
- Distinguer une disponibilité connue, inconnue ou épuisée.
- Filtrer le board compact sur une taille exacte disponible.
- Afficher les tailles connues directement sur les cartes sans ouvrir le shop.
- Enrichir le catalogue existant avec les fiches détaillées et indiquer la couverture.

Critère de sortie : choisir `M`, `L`, `48` ou une autre taille enregistrée ne laisse que les produits actuellement commandables dans cette taille ; les articles inconnus ne sont jamais présentés comme des correspondances confirmées.

## Sprint 2 — Shortlist et comparaison

- Persister les décisions « gardé », « rejeté » et « possédé » depuis le board.
- Ajouter un board réservé à la shortlist et une comparaison compacte côte à côte.
- Montrer prix, tailles disponibles, matière, retours et raison de la sélection visuelle.
- Empêcher les produits rejetés de réapparaître dans les recherches Codex sauf demande explicite.

Critère de sortie : une session de navigation peut se terminer par une petite shortlist d’achat durable.

## Sprint 3 — Acquisition fiable et fraîcheur

- Ajouter une file d’enrichissement des fiches existantes avec progression et reprises.
- Enregistrer la dernière vérification du prix et du stock et signaler les données périmées.
- Rafraîchir à la demande seulement la shortlist ou les produits visibles.
- Ajouter le prochain shop suisse via un adaptateur isolé et normaliser ses tailles.

Critère de sortie : chaque disponibilité a une date de capture visible et peut être rafraîchie sans rescanner tout le catalogue.

## Sprint 4 — Boucle de styliste agentique

- Permettre à Luna de combiner texte, mood boards, favoris, rejets et vêtements possédés.
- Diffuser les articles inspectés et les raisons concises pendant le travail de l’agent.
- Appliquer taille et budget comme contraintes dures avant le scoring visuel.
- Réinjecter les décisions garder/rejeter dans la sélection suivante.

Critère de sortie : une requête agentique produit une sélection pertinente et achetable, avec une raison pour chaque survivant.

## Sprint 5 — Dressing personnel et planches de tenues

- Importer vêtements possédés et références avec métadonnées modifiables.
- Générer des planches de tenues autour d’un achat potentiel.
- Évaluer la nouveauté et la compatibilité avec ce qui est déjà possédé.
- Identifier les manques du dressing au lieu de classer seulement des pièces isolées.

Critère de sortie : l’app peut dire si un achat ajoute réellement des tenues utiles au dressing.

## Sprint 6 — Échelle et finition

- Virtualiser les très grands boards et mettre en cache projections et planches-contact.
- Ajouter vues sauvegardées, exports locaux, navigation clavier et annulation.
- Auditer accessibilité, tactile/mobile, erreurs et récupération des données.
- Ajouter des fixtures et tests de régression pour chaque shop pris en charge.

Critère de sortie : plusieurs milliers de produits restent fluides et les parcours principaux sont robustes.

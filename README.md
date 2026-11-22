# Lily Garden

Une scène de lys (*Lilium*) roses et blancs en pixel art, de nuit, bercée par une brise légère.
Pas de menu, pas de bouton, pas de texte : juste le jardin, et une petite berceuse.

## La musique

Une valse originale façon boîte à musique (16 mesures en fa majeur qui bouclent), générée en direct par le navigateur avec Web Audio : aucun fichier son. Un carillon montant accompagne l'éclatement de chaque salve de cœurs.

Les navigateurs, et l'iPhone en particulier, n'autorisent le son qu'après un geste : **un toucher sur l'écran lance la musique** (en fondu), un autre la coupe. Tant que le son est coupé, une petite note de musique rose respire en haut à gauche. Sur iPhone, la musique joue même avec le bouton silencieux activé (iOS 17 et plus) ; il faut simplement que le volume soit monté.

## Lancer la scène

**Le plus simple :** double-cliquer sur `index.html`. La scène n'a besoin ni de serveur ni de dépendance.

**Avec un petit serveur local** (pratique pour l'ouvrir sur un téléphone du même Wi-Fi) :

```bash
python -m http.server 8642
```

Puis ouvrir `http://localhost:8642` (ou `http://<IP-du-PC>:8642` depuis le téléphone).

## Publier gratuitement avec GitHub Pages

1. Créer un compte sur <https://github.com> si besoin, puis **New repository** (par exemple `lily-garden`), en **Public**.
2. Sur la page du dépôt : **Add file → Upload files**, glisser `index.html`, `style.css`, `main.js`, `manifest.json`, `icon.png` et `README.md`, puis **Commit changes**.
3. Aller dans **Settings → Pages**. Dans **Build and deployment**, choisir *Source : Deploy from a branch*, branche `main`, dossier `/ (root)`, puis **Save**.
4. Après une ou deux minutes, le lien s'affiche en haut de cette page :
   `https://<votre-pseudo>.github.io/lily-garden/`

C'est ce lien qu'il suffit d'envoyer.

## Sur iPhone

- **À l'horizontale :** la scène est pensée pour être vue téléphone à l'horizontale. Safari ne permet à aucun site de forcer la rotation : tant que le téléphone est tenu à la verticale, la scène est voilée et un petit téléphone en pixel art pivote sous une flèche, un cœur battant à l'écran. Dès qu'on tourne le téléphone, le spectacle démarre depuis le début (feux d'artifice compris). Un simple toucher permet aussi de rester à la verticale.
- **En plein écran :** depuis Safari, *Partager → Sur l'écran d'accueil*. L'icône (un cœur en pixel art) lance ensuite la scène sans barre d'adresse.
- **Le verrouillage de la rotation** doit être désactivé dans le Centre de contrôle pour que le téléphone passe à l'horizontale.
- En paysage, les pixels sont plus gros (hauteur interne d'environ 230 px au lieu de 426) pour que les fleurs restent bien lisibles sur un petit écran ; les tiges, les fleurs, les cœurs et le bouquet s'adaptent à cette hauteur.
- Le pincement pour zoomer et le rebond de la page sont désactivés, et la scène se recalcule après une rotation (iOS donne parfois les nouvelles dimensions avec un léger retard).

Avec la ligne de commande, c'est l'équivalent de :

```bash
git init && git add . && git commit -m "Lily Garden" && git branch -M main && git remote add origin https://github.com/<votre-pseudo>/lily-garden.git && git push -u origin main
```

## Comment c'est construit

Tout est dans `main.js`, en JavaScript vanilla, sans dépendance.

| Classe / fonction | Rôle |
| --- | --- |
| `LilyFlower` | Fleur de lys vue de trois quarts : six tépales pointus en étoile, pliés le long de leur nervure, à pointe recourbée, bord pâle et mouchetures sur les lys roses ; gorge verte, trompette visible quand la fleur est de profil, six étamines aux anthères orangées et un pistil. Projection 3D simple avec z-buffer, quantifiée sur une rampe de 8 tons. Variétés `stargazer` (rose moucheté), `white` et `blush`. |
| `LilyBud` | Bouton fermé en fuseau, vert à la base, avec les sutures des tépales. |
| `LilyLeaf` | Feuille étroite et lancéolée, légèrement arquée, deux moitiés éclairées différemment, nervure claire. Deux images par feuille pour un léger basculement. |
| `Wind` | Balancement : deux sinusoïdes par massif, déphasées le long de la tige, modulées par une rafale lente. |
| `LilyPlant` | Hautes tiges vertes (courbes de Bézier), feuilles alternes qui montent le long de la tige, fleurs et boutons au bout de courts pédoncules. Les fleurs sont dessinées ligne par ligne avec un décalage croissant pour qu'elles fléchissent sans quitter la grille de pixels. |
| `GroundCover` | Feuilles longues au premier plan, au sol. |
| `buildBackground` | Ciel tramé (Bayer 4×4) de l'indigo au rose crépusculaire, pleine lune nacrée, bokeh rosé, massif de lys lointain : pré-calculé une seule fois. |
| `Sky` | Étoiles qui scintillent, et une constellation en forme de cœur qu'une onde de lumière parcourt une fois par boucle. |
| `HeartFirework` | Feux d'artifice : à chaque salve, trois fusées roses montent de derrière les lys et éclatent en cœurs d'étincelles (un grand au centre, deux plus petits sur les côtés), qui retombent et s'éteignent doucement. Une salve dès l'ouverture (les cœurs sont ouverts après environ 2,5 s), puis toutes les 16 secondes. La taille et la position des cœurs se règlent dans `Scene`. |
| `Peony`, `buildBouquet`, `BouquetVision` | Après les retombées de chaque salve, un bouquet rose et blanc apparaît au centre : lys roses et blancs avec leurs boutons, pivoines roses et blanches, verdure, gypsophile, papier rose et blanc, nœud de ruban rose. Il éclot pixel par pixel du centre vers les bords dans une lueur rose, flotte et scintille environ 5 secondes, puis se dissout avant la salve suivante. Sa taille se règle avec `K` dans `buildBouquet`. |
| `Motes`, `PetalSystem`, `FloatingHearts` | Lucioles dorées-rosées, pétales roses et blancs qui se détachent (9 par boucle), petits cœurs qui s'élèvent des fleurs (3 par boucle). |
| `Lullaby` | La berceuse : planification des notes en avance sur l'horloge audio, clochettes (partiels légèrement inharmoniques), arpèges, basse, réverbération par convolution. Mise en pause avec l'onglet. |
| `RotatePrompt` | Invitation sans texte à tourner le téléphone : petit téléphone qui pivote, flèche, cœur battant. |
| `Scene`, `App` | Composition, mise à l'échelle nette, boucle d'animation, détection du téléphone et de l'orientation. |

### Règles du pixel art

- La scène est composée dans un petit framebuffer (≈ 195 × 422 px en portrait), pixel par pixel, sans aucun antialiasing.
- Elle est agrandie d'un **facteur entier** en pixels physiques (`devicePixelRatio` pris en compte), en nearest-neighbor : chaque pixel art couvre exactement un carré de pixels de l'écran.
- La hauteur interne vise 426 px en portrait et 250 px en paysage ; la largeur s'adapte au format, donc il n'y a jamais de bandes noires ni de zone blanche.
- Tous les mouvements se font par pas d'un pixel entier.

### Animation

- Toutes les fréquences sont des multiples entiers de `2π / 48 s` : la scène boucle parfaitement toutes les 48 secondes.
- Les détails aléatoires viennent de graines fixes : le jardin est identique à chaque visite.
- L'animation se met en pause quand l'onglet est masqué.
- Avec `prefers-reduced-motion`, la scène s'affiche en image fixe.
- Une image coûte environ 1,5 ms sur un PC. Si un appareil peine (plus de 12 ms par image), le rendu passe automatiquement à 30 images par seconde.

## Personnaliser

Tout se règle en haut de `main.js` :

- `CONFIG.seed` : une autre graine donne un autre jardin.
- `CONFIG.petalsPerLoop` : plus ou moins de pétales.
- `CONFIG.heartsPerLoop` : plus ou moins de petits cœurs (0 pour les retirer).
- `CONFIG.fireworkTimes` : les instants (en secondes, entre 0 et 48) où le cœur est lancé, par défaut `[0.5, 16.5, 32.5]` ; `[0.5]` pour une seule salve par boucle, `[]` pour les retirer.
- `CONFIG.loop` : la durée de la boucle.
- `MUSIC` : tempo (`bpm`), volume, accords et mélodie de la berceuse (notes MIDI et durées en temps).
- `PALETTE` : toutes les couleurs (lys `stargazer`, `white`, `blush`, feuillage, ciel, bouquet…).
- `TEMPLATES` : la forme des massifs de lys (hauteur des tiges, taille `R` et ouverture `open` des fleurs, boutons).

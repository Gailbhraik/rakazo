/**
 * Empêche le zoom tactile sur mobile.
 *
 * La balise viewport suffit à Chrome sous Android, mais Safari ignore
 * `user-scalable=no` depuis iOS 10 : le seul levier restant y est l'événement
 * `gesture*`, propre à WebKit, qu'on annule.
 *
 * Le double-tap est traité à part, en CSS (`touch-action: manipulation`).
 *
 * On ne touche qu'au zoom tactile : le zoom du navigateur au clavier ou au
 * menu reste disponible, et c'est important — supprimer tout moyen d'agrandir
 * exclurait les personnes qui en ont besoin pour lire.
 */
export function blockPinchZoom(target: Pick<Window, "addEventListener"> = window): void {
  const stop = (event: Event) => event.preventDefault();
  for (const name of ["gesturestart", "gesturechange", "gestureend"]) {
    target.addEventListener(name, stop, { passive: false });
  }
}

-- Avatar Pokémon d'un bot, par numéro national.
-- Nul par défaut : les bots existants gardent l'avatar généré depuis leur
-- couleur, et le champ ne devient visible qu'une fois choisi.
ALTER TABLE "bots" ADD COLUMN "pokemon" INTEGER;

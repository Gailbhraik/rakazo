-- Modèles épinglés par un membre pour basculer vite entre eux.
-- Distinct de space_model_preferences, qui porte le modèle réellement actif :
-- un favori est un raccourci, il n'applique rien par lui-même.

CREATE TABLE "space_favorite_models" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_favorite_models_pkey" PRIMARY KEY ("id")
);

-- Un même modèle ne peut être épinglé deux fois par le même membre.
CREATE UNIQUE INDEX "space_favorite_models_spaceId_userId_provider_modelId_key"
    ON "space_favorite_models"("spaceId", "userId", "provider", "modelId");

-- La liste se lit toujours pour un membre, dans l'ordre d'ajout.
CREATE INDEX "space_favorite_models_spaceId_userId_createdAt_idx"
    ON "space_favorite_models"("spaceId", "userId", "createdAt");

ALTER TABLE "space_favorite_models"
    ADD CONSTRAINT "space_favorite_models_spaceId_userId_fkey"
    FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId")
    ON DELETE CASCADE ON UPDATE CASCADE;

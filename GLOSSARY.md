# Glossary

## Save barrier

The handshake that asks every ready Live Preview peer of one document to submit
pending edits, authenticates each flush receipt by peer and request ID, drains
the host edit queue, and rejects retained conflicts before extension-owned
persistence. Hidden ready peers participate too.

The [Live Preview save module](src/extension/livePreviewSaveCoordinator.ts) owns
the barrier and the persistence lifecycle shared by preview and native saves.

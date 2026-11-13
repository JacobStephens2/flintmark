# Glossary

## Live Preview edit synchronization

The per-document protocol that orders received Live Preview input with host
edits, identifies accepted input, retains unsynchronized edits for retry or
recovery, and supplies conflict state to the Save barrier.

The [Live Preview edit module](src/extension/livePreviewEditCoordinator.ts) owns
this protocol behind a host-independent interface.

## Save barrier

The handshake that asks every ready Live Preview peer of one document to submit
pending edits, authenticates each flush receipt by peer and request ID, drains
the host edit queue, and rejects retained conflicts before extension-owned
persistence. Hidden ready peers participate too.

The [Live Preview save module](src/extension/livePreviewSaveCoordinator.ts) owns
the barrier and the persistence lifecycle shared by preview and native saves.

# Glossary

## Image snapshot

An immutable, per-workspace-root image membership and resolution view. It retains
original root-relative path spellings, derives normalized lookups internally,
and creates a replacement view when paths change. Its status determines whether
indexed resolution is available.

The [Image snapshot module](src/extension/vault/imageResolver.ts) owns image
membership, path patches, and resolution behind a host-independent interface.

## Live Preview edit synchronization

The per-document protocol that orders received Live Preview input with host
edits, identifies accepted input, retains unsynchronized edits for retry or
recovery, and supplies conflict state to the Save barrier.

The [Live Preview edit module](src/extension/livePreviewEditCoordinator.ts) owns
this protocol behind a host-independent interface.

## Note-folder creation

The shared operation that derives a destination beside a note and creates a
note or image attachment while preserving validation, collision, and
no-overwrite rules.

The [Note-folder creation module](src/extension/vault/noteFolderCreation.ts)
owns naming and creation policy behind a host-independent interface.

## Save barrier

The handshake that asks every ready Live Preview peer of one document to submit
pending edits, authenticates each flush receipt by peer and request ID, drains
the host edit queue, and rejects retained conflicts before extension-owned
persistence. Hidden ready peers participate too.

The [Live Preview save module](src/extension/livePreviewSaveCoordinator.ts) owns
the barrier and the persistence lifecycle shared by preview and native saves.

## Vault index publication

The process that orders content refreshes and cooperative rebuilds of per-root
note snapshots into the last complete, globally queryable graph, original URI
lookup, and autocomplete data.

The [Vault index publication module](src/extension/vault/vaultPublication.ts)
owns publication ordering and the queries it protects behind a host-independent
interface.

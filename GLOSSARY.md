# Glossary

## Image snapshot

An immutable, per-workspace-root image membership and resolution view. It retains
original root-relative path spellings, derives normalized lookups internally,
and creates a replacement view when paths change. Its status determines whether
indexed resolution is available.

The [Image snapshot module](src/extension/vault/imageResolver.ts) owns image
membership, path patches, and resolution behind a host-independent interface.

## Live Preview image publication

The per-panel process that turns current note image references and Image
snapshot resolution into complete image maps offered after initialization. It
owns raw reference keys, synchronous indexed/fallback resolution choice,
duplicate suppression, and resending after every ready/init handshake.

The [Live Preview image publication module](src/extension/livePreviewImagePublication.ts)
owns this process behind a host-independent interface.

## Live Preview edit synchronization

The per-document protocol that orders received Live Preview input with host
edits, identifies accepted input, retains unsynchronized edits for retry or
recovery, and supplies conflict state to the Save barrier.

The [Live Preview edit module](src/extension/livePreviewEditCoordinator.ts) owns
this protocol behind a host-independent interface.

## Live Preview synchronization

The host-side process that tracks registered and ready preview peers and orders
received edits, native undo and redo, and save persistence for each TextDocument.

The [Live Preview synchronization module](src/extension/livePreviewSynchronization.ts)
composes [Live Preview edit synchronization](#live-preview-edit-synchronization)
and the [Save barrier](#save-barrier).

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

## Workspace indexing

The multi-root, multi-spec process that turns host searches, watcher
invalidations, exclusions, and freshness checks into serialized, incremental
per-root snapshots and refresh notifications.

The [Workspace indexing module](src/extension/vault/workspaceIndexing.ts) owns
multi-root tracking, spec routing, exclusions, scheduling, reconciliation, and
path-normalization rules behind a host-independent interface.

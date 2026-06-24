# Artifact Management Module - Test Cases

## TC-ART-001: Upload Artifact (new file)

| Item | Value |
|------|-------|
| Priority | High |
| Precondition | Object Store service is running; a local test file exists |
| Input | `POST /api/artifacts/upload` with `{ filePath: "<test-file>", tags: ["firmware", "test"] }` |
| Expected Status | 201 |
| Expected Response | `{ status: "success", artifact: ArtifactMeta }` with `fileName === "firmware_v1.fw"`, `refCount === 0`, valid 64-character SHA-256 `checksum` |

## TC-ART-002: Upload Artifact (deduplication)

| Item | Value |
|------|-------|
| Priority | High |
| Precondition | An artifact with the same checksum already exists |
| Input | `POST /api/artifacts/upload` with a file that has identical content to an existing artifact |
| Expected Status | 200 |
| Expected Response | `{ status: "deduplicated", artifact: ArtifactMeta }` pointing to the existing artifact |

## TC-ART-003: List Artifacts

| Item | Value |
|------|-------|
| Priority | High |
| Precondition | At least 1 artifact exists |
| Input | `GET /api/artifacts` |
| Expected Status | 200 |
| Expected Response | `{ items: ArtifactMeta[], total: number }` with `total >= 1` |

## TC-ART-004: Get Artifact

| Item | Value |
|------|-------|
| Priority | High |
| Precondition | An artifact with known ID exists |
| Input | `GET /api/artifacts/{id}` |
| Expected Status | 200 |
| Expected Response | Complete `ArtifactMeta` with correct `id`, `fileName`, `size`, `checksum` |

## TC-ART-005: Get Artifact (not found)

| Item | Value |
|------|-------|
| Priority | High |
| Precondition | No artifact with the given ID |
| Input | `GET /api/artifacts/nonexistent-artifact` |
| Expected Status | 404 |
| Expected Response | `{ error: "ARTIFACT_NOT_FOUND" }` |

## TC-ART-006: Update Artifact metadata (tags, metadata)

| Item | Value |
|------|-------|
| Priority | High |
| Precondition | An artifact exists |
| Input | `PUT /api/artifacts/{id}` with `{ tags: ["after-update"], metadata: { version: "2.0" } }` |
| Expected Status | 200 |
| Expected Response | `ArtifactMeta` with updated `tags` and `metadata`; immutable fields unchanged |

## TC-ART-007: Delete Artifact (refCount = 0)

| Item | Value |
|------|-------|
| Priority | High |
| Precondition | An artifact with `refCount === 0` exists |
| Input | `DELETE /api/artifacts/{id}` |
| Expected Status | 204 |
| Postcondition | Subsequent `GET /api/artifacts/{id}` returns 404 |

## TC-ART-008: Delete Artifact (refCount > 0, should fail)

| Item | Value |
|------|-------|
| Priority | High |
| Precondition | An artifact with `refCount > 0` exists |
| Input | `DELETE /api/artifacts/{id}` |
| Expected Status | 409 |
| Expected Response | `{ error: "ARTIFACT_REFERENCED" }` with message indicating reference count |

## TC-ART-009: Increment/Decrement Ref Count

| Item | Value |
|------|-------|
| Priority | High |
| Precondition | An artifact with `refCount === 0` exists |
| Input | 1. `POST /api/artifacts/{id}/increment-ref` 2. `POST /api/artifacts/{id}/increment-ref` 3. `POST /api/artifacts/{id}/decrement-ref` |
| Expected Result | After step 1: `refCount === 1`; after step 2: `refCount === 2`; after step 3: `refCount === 1` |

## TC-ART-010: Delete Artifact (invalid ID format)

| Item | Value |
|------|-------|
| Priority | Medium |
| Precondition | None |
| Input | `DELETE /api/artifacts/invalid id!` |
| Expected Status | 400 |
| Expected Response | `{ error: "INVALID_ARTIFACT_ID" }` |

## TC-ART-011: Ref Count Audit

| Item | Value |
|------|-------|
| Priority | Medium |
| Precondition | Artifacts and solutions exist |
| Input | `POST /api/artifacts/audit/ref-count` |
| Expected Status | 200 |
| Expected Response | `{ corrected: number, inconsistencies: number }` |

## TC-ART-012: Upload Artifact (custom ID)

| Item | Value |
|------|-------|
| Priority | Medium |
| Precondition | No artifact with the custom ID exists |
| Input | `POST /api/artifacts/upload` with `{ filePath: "<test-file>", customId: "my-custom-id" }` |
| Expected Status | 201 |
| Expected Response | `ArtifactMeta` with `id === "my-custom-id"` |

## TC-ART-013: Upload Artifact (duplicate custom ID)

| Item | Value |
|------|-------|
| Priority | Medium |
| Precondition | An artifact with the custom ID already exists |
| Input | `POST /api/artifacts/upload` with `{ filePath: "<test-file>", customId: "existing-id" }` |
| Expected Status | 200 |
| Expected Response | `{ status: "failed", error: "Artifact ID already exists" }` |

## TC-ART-014: List Artifacts (filter by contentType)

| Item | Value |
|------|-------|
| Priority | Medium |
| Precondition | Artifacts of different content types exist |
| Input | `GET /api/artifacts?filter[contentType]=application/x-firmware` |
| Expected Status | 200 |
| Expected Response | All returned artifacts have `contentType === "application/x-firmware"` |

## TC-ART-016: Get artifact storage path

| Item | Value |
|------|-------|
| Priority | Medium |
| Precondition | An artifact with known ID exists |
| Input | Call `artifactService.getArtifactPath(id)` |
| Expected Result | Returns the absolute filesystem path of the stored artifact file |

## TC-ART-017: Get artifact storage path (not found)

| Item | Value |
|------|-------|
| Priority | Medium |
| Precondition | No artifact with the given ID |
| Input | Call `artifactService.getArtifactPath("nonexistent")` |
| Expected Result | Throws `ArtifactNotFoundError` |

## TC-ART-015: List Artifacts (filter by fileName substring)

| Item | Value |
|------|-------|
| Priority | Medium |
| Precondition | Artifacts with various file names exist |
| Input | `GET /api/artifacts?filter[fileName]=firmware` |
| Expected Status | 200 |
| Expected Response | All returned artifacts have `fileName` containing "firmware" |

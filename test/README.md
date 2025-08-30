# Test Directory

## Purpose
This directory contains files required by third-party libraries as workarounds for their implementation issues.

## Files

### `data/05-versions-space.pdf`
- **Required by**: `pdf-parse` library
- **Issue**: The library has hardcoded test file dependencies that run during import
- **Solution**: This minimal PDF file prevents import crashes
- **Status**: Temporary workaround until library is replaced

## Note for Developers
Do not delete files in this directory unless you're replacing the associated library. These files are not actual tests but dependency workarounds.
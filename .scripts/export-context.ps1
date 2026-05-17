# Export project context to .aicontext files for Gemini continuity
# Usage: .\export-context.ps1
# Output: claude.aicontext, website.aicontext, misc.aicontext in the repo root

$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptDir = $PSScriptRoot
$clauseFile = Join-Path $scriptDir "claude.aicontext"
$websiteFile = Join-Path $scriptDir "website.aicontext"
$miscFile = Join-Path $scriptDir "misc.aicontext"

# Clear any existing files
@($clauseFile, $websiteFile, $miscFile) | ForEach-Object {
    if (Test-Path $_) { Remove-Item $_ }
}

# Patterns for categorization
$claudePatterns = @("*.md", "CLAUDE.md", ".claude/*", "STATUS.md")
$websitePatterns = @("*.js", "*.html", "*.css", "manifest.json", "*.json")
$miscPatterns = @(".gitignore", "README.md", "migration/*")

# Files to always exclude
$excludePatterns = @("*.png", "*.jpg", "*.jpeg", "*.gif", "*.stackdump", ".git/*", ".playwright*", "node_modules/*", "dist/*", "build/*", ".scripts/*")

function ShouldExclude([string]$filePath) {
    $relativePath = $filePath.Substring($repoRoot.Length + 1)

    foreach ($pattern in $excludePatterns) {
        if ($relativePath -like $pattern -or $relativePath -match [regex]::Escape($pattern).Replace("\*", ".*")) {
            return $true
        }
    }

    return $false
}

function CategorizeFile([string]$filePath) {
    $relativePath = $filePath.Substring($repoRoot.Length + 1)
    $fileName = Split-Path -Leaf $filePath

    # Claude context: plans, status, documentation
    if ($relativePath -like "*STATUS.md" -or
        $relativePath -like "*.md" -or
        $relativePath -like ".claude/*" -or
        $fileName -eq "CLAUDE.md" -or
        $relativePath -like "notes/*") {
        return "claude"
    }

    # Website: app code
    if ($relativePath -like "*.js" -or
        $relativePath -like "*.html" -or
        $relativePath -like "*.css" -or
        $relativePath -like "manifest.json" -or
        $relativePath -like "service-worker.js" -or
        $relativePath -like "app.js" -or
        $relativePath -like "sync.js" -or
        $relativePath -like "index.html") {
        return "website"
    }

    # Everything else useful
    return "misc"
}

function AppendFile([string]$contextFile, [string]$sourceFile) {
    $relativePath = $sourceFile.Substring($repoRoot.Length + 1)

    # Add file header with path
    Add-Content -Path $contextFile -Value ""
    Add-Content -Path $contextFile -Value "================================================================================`n`FILE: $relativePath`n================================================================================"
    Add-Content -Path $contextFile -Value ""

    # Add file content
    $content = Get-Content -Path $sourceFile -Raw -ErrorAction Continue
    if ($content) {
        Add-Content -Path $contextFile -Value $content
    }

    Add-Content -Path $contextFile -Value ""
}

# Find all files in the repo
$allFiles = Get-ChildItem -Path $repoRoot -Recurse -File -ErrorAction SilentlyContinue

Write-Host "Scanning repo..." -ForegroundColor Cyan
Write-Host "Found $($allFiles.Count) files total"

$claudeFiles = @()
$websiteFiles = @()
$miscFiles = @()
$excludedCount = 0

foreach ($file in $allFiles) {
    if (ShouldExclude $file.FullName) {
        $excludedCount++
        continue
    }

    $category = CategorizeFile $file.FullName

    switch ($category) {
        "claude" { $claudeFiles += $file.FullName }
        "website" { $websiteFiles += $file.FullName }
        "misc" { $miscFiles += $file.FullName }
    }
}

Write-Host "Excluded: $excludedCount files (images, git cruft, etc.)" -ForegroundColor Gray
Write-Host ""
Write-Host "Writing context files..." -ForegroundColor Cyan

# Write Claude context
Write-Host "  claude.aicontext ($($claudeFiles.Count) files)" -ForegroundColor Green
Add-Content -Path $clauseFile -Value "# Claude Context Export`n# Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n# Repo: food-and-weight`n"
$claudeFiles | Sort-Object | ForEach-Object {
    AppendFile $clauseFile $_
}

# Write Website context
Write-Host "  website.aicontext ($($websiteFiles.Count) files)" -ForegroundColor Green
Add-Content -Path $websiteFile -Value "# Website Context Export`n# Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n# Repo: food-and-weight`n"
$websiteFiles | Sort-Object | ForEach-Object {
    AppendFile $websiteFile $_
}

# Write Misc context
Write-Host "  misc.aicontext ($($miscFiles.Count) files)" -ForegroundColor Green
Add-Content -Path $miscFile -Value "# Miscellaneous Context Export`n# Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n# Repo: food-and-weight`n"
$miscFiles | Sort-Object | ForEach-Object {
    AppendFile $miscFile $_
}

Write-Host ""
Write-Host "✓ Export complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Output files:" -ForegroundColor Cyan
$($clauseFile, $websiteFile, $miscFile) | ForEach-Object {
    if (Test-Path $_) {
        $size = (Get-Item $_).Length / 1KB
        Write-Host "  $_ ($([math]::Round($size, 2)) KB)"
    }
}

Write-Host ""
Write-Host "To use with Gemini:" -ForegroundColor Yellow
Write-Host "1. Open https://gemini.google.com"
Write-Host "2. Start a new conversation"
Write-Host "3. Paste the contents of each .aicontext file into the chat"
Write-Host "4. Reference them as needed for context"

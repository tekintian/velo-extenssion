cd /Volumes/work/projects/rust/velo/extensions/velo-extension
echo "=== tsc ==="
npx tsc --noEmit 2>&1 | tail -n 20
echo "=== eslint ==="
npx eslint src tests --max-warnings 0 2>&1 | tail -n 25
echo "=== vitest ==="
npx vitest run 2>&1 | tail -n 10

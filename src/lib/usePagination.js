import { useState, useEffect, useMemo } from 'react'

// =====================================================================
// GOODIE-MEDHUB — Shared pagination hook (Global Pagination Rule)
//
// Takes a full array of records already loaded into memory (from
// useOfflineTable) and returns just the slice for the current page,
// plus everything a <Pagination /> control needs to drive it.
//
// IMPORTANT ARCHITECTURE NOTE:
// This app's offline-first design (useOfflineTable) pulls every row for
// the hospital down into the browser's local database so the app keeps
// working without internet. That means pagination here happens in the
// browser, over data that is already local — it does NOT re-query
// Supabase page by page. True server-side LIMIT/OFFSET pagination would
// conflict with that offline design (a page you never visited while
// online would never load without internet). This hook still delivers
// the visible behaviour requested (only render 20/50 rows at a time,
// proper Previous/Next, "Showing X-Y of Z") without breaking offline mode.
//
// resetKey: pass in your search term / filters. Whenever this value
// changes, the page resets to 1 automatically, so a new search never
// leaves the user stranded on "page 4 of 1".
// =====================================================================

export function usePagination(items, { pageSize: initialPageSize = 20, resetKey } = {}) {
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(initialPageSize)

  // Defensive: `items` MUST be an array. If a caller ever passes a non-array
  // (e.g. an options object by mistake, or a hook that returned null while
  // loading), fall back to an empty array so `items.length` / `items.slice()`
  // never throw `t.slice is not a function` and the page renders an empty
  // list instead of a white screen. This does NOT change behaviour for any
  // caller that already passes a real array.
  const list = Array.isArray(items) ? items : []

  // Reset to page 1 whenever the search/filter changes.
  useEffect(() => {
    setCurrentPage(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  const totalItems = list.length
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))

  // If the list shrank (e.g. a record was deleted) and the current page
  // no longer exists, snap back instead of showing a blank page.
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const startIndex = (currentPage - 1) * pageSize
  const endIndex = Math.min(startIndex + pageSize, totalItems)

  const pageItems = useMemo(
    () => list.slice(startIndex, endIndex),
    [list, startIndex, endIndex]
  )

  function changePageSize(newSize) {
    setPageSize(newSize)
    setCurrentPage(1)
  }

  return {
    pageItems,
    currentPage,
    setCurrentPage,
    pageSize,
    setPageSize: changePageSize,
    totalPages,
    totalItems,
    startIndex,
    endIndex,
  }
}

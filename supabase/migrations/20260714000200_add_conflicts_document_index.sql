create index conflicts_document_idx
  on public.conflicts (document_id)
  where document_id is not null;

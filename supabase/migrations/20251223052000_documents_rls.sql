ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS documents_service_role_all ON public.documents;
CREATE POLICY documents_service_role_all
  ON public.documents
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

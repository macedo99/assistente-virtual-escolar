-- No "Marcar como erro" do workflow "RAG - Reindexar item" do n8n
UPDATE itens_base_conhecimento
   SET status_indexacao = 'erro', atualizado_em = now()
 WHERE id = $1;

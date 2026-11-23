-- 1) Quem escreveu cada mensagem do atendente.
ALTER TABLE mensagens
    ADD COLUMN IF NOT EXISTS atendente_id BIGINT REFERENCES atendentes(id) ON DELETE SET NULL;


-- 2) Trilha de eventos: uma linha a cada mudança de status de uma conversa.
CREATE TABLE IF NOT EXISTS conversa_eventos (
    id               BIGSERIAL PRIMARY KEY,
    conversa_id      BIGINT NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
    status_anterior  VARCHAR(20),                    -- nulo = a conversa acabou de ser criada
    status_novo      VARCHAR(20) NOT NULL,
    atendente_id     BIGINT REFERENCES atendentes(id) ON DELETE SET NULL, -- responsável naquele momento
    criado_em        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eventos_conversa ON conversa_eventos(conversa_id, id);


-- 3) Quem grava os eventos é o próprio banco (um gatilho/trigger)
CREATE OR REPLACE FUNCTION registrar_evento_conversa() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO conversa_eventos (conversa_id, status_anterior, status_novo, atendente_id)
        VALUES (NEW.id, NULL, NEW.status, NEW.atendente_id);
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        -- COALESCE: ao devolver ao bot o atendente_id da conversa vira nulo, mas o evento ainda
        -- deve dizer quem era o responsável.
        INSERT INTO conversa_eventos (conversa_id, status_anterior, status_novo, atendente_id)
        VALUES (NEW.id, OLD.status, NEW.status, COALESCE(NEW.atendente_id, OLD.atendente_id));
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_conversa_eventos ON conversas;
CREATE TRIGGER trg_conversa_eventos
    AFTER INSERT OR UPDATE OF status ON conversas
    FOR EACH ROW EXECUTE FUNCTION registrar_evento_conversa();


-- 4) No máximo UMA conversa ativa (não encerrada) por usuário.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM conversas
        WHERE status <> 'encerrada'
        GROUP BY usuario_id
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'Existe usuário com mais de uma conversa ativa. Veja o guia do Passo 8a (Solução de problemas), encerre as duplicadas e rode de novo.';
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversa_ativa_por_usuario
    ON conversas(usuario_id)
    WHERE status <> 'encerrada';

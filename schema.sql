CREATE TABLE usuarios (
    id                 BIGSERIAL PRIMARY KEY,
    telegram_chat_id   BIGINT NOT NULL UNIQUE,
    telegram_username  VARCHAR(64),
    nome               VARCHAR(120),
    papel              VARCHAR(20) NOT NULL DEFAULT 'professor'
                       CHECK (papel IN ('professor', 'gestor')),
    criado_em          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE atendentes (
    id             BIGSERIAL PRIMARY KEY,
    nome           VARCHAR(120) NOT NULL,
    email          VARCHAR(160) NOT NULL UNIQUE,
    senha_hash     VARCHAR(255) NOT NULL,
    papel          VARCHAR(20) NOT NULL DEFAULT 'atendente'
                   CHECK (papel IN ('admin', 'atendente')),
    ativo          BOOLEAN NOT NULL DEFAULT true,
    criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversas (
    id              BIGSERIAL PRIMARY KEY,
    usuario_id      BIGINT NOT NULL REFERENCES usuarios(id),
    atendente_id    BIGINT REFERENCES atendentes(id) ON DELETE SET NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'bot'
                    CHECK (status IN ('bot', 'aguardando_atendente', 'atendimento_humano', 'encerrada')),
    iniciada_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
    encerrada_em    TIMESTAMPTZ
);

CREATE TABLE mensagens (
    id              BIGSERIAL PRIMARY KEY,
    conversa_id     BIGINT NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
    remetente       VARCHAR(20) NOT NULL CHECK (remetente IN ('usuario', 'bot', 'atendente')),
    conteudo        TEXT NOT NULL,
    feedback        VARCHAR(10) CHECK (feedback IN ('positivo', 'negativo')),
    enviada_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mensagens_conversa ON mensagens(conversa_id);
CREATE INDEX idx_conversas_usuario ON conversas(usuario_id);
CREATE INDEX idx_conversas_status ON conversas(status);

CREATE TABLE itens_base_conhecimento (
    id                  BIGSERIAL PRIMARY KEY,
    titulo              VARCHAR(200) NOT NULL,
    conteudo            TEXT NOT NULL,
    fonte               VARCHAR(200),
    status_indexacao    VARCHAR(20) NOT NULL DEFAULT 'pendente'
                        CHECK (status_indexacao IN ('pendente', 'indexado', 'erro')), 
    criado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
    atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trechos_embeddings (
    id               BIGSERIAL PRIMARY KEY,
    item_id          BIGINT NOT NULL REFERENCES itens_base_conhecimento(id) ON DELETE CASCADE,
    conteudo_trecho  TEXT NOT NULL,
    embedding        VECTOR(1536),
    criado_em        TIMESTAMPTZ NOT NULL DEFAULT now()
);
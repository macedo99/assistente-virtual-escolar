-- Queries dos nós Postgres do n8n
SELECT u.id AS usuario_id, u.papel, c.id AS conversa_id
FROM usuarios u
LEFT JOIN conversas c ON c.usuario_id = u.id
WHERE u.telegram_chat_id = $1
ORDER BY c.iniciada_em DESC
LIMIT 1;

-- Query Parameters:
-- {{ $('Telegram Trigger').item.json.message.chat.id }}


-- ===================================================================
-- Nó "Inserir usuário"  (branch "outro", quando o texto é professor/gestor)
-- ===================================================================
INSERT INTO usuarios (telegram_chat_id, telegram_username, nome, papel)
VALUES ($1, $2, $3, $4)
RETURNING id AS usuario_id;

-- Query Parameters:
-- {{ $('Telegram Trigger').item.json.message.chat.id }}, {{ $('Telegram Trigger').item.json.message.chat.username }}, {{ $('Telegram Trigger').item.json.message.chat.first_name }}, {{ $('Telegram Trigger').item.json.message.text.toLowerCase().includes('gestor') ? 'gestor' : 'professor' }}


-- ===================================================================
-- Nó "Abrir conversa"  (logo depois de "Inserir usuário")
-- ===================================================================
INSERT INTO conversas (usuario_id, status)
VALUES ($1, 'bot')
RETURNING id AS conversa_id;

-- Query Parameters:
-- {{ $('Inserir usuário').item.json.usuario_id }}


-- ===================================================================
-- Nó "Gravar mensagem"  (um nó, usado 2x: mensagem do usuário e resposta do bot)
-- ===================================================================
INSERT INTO mensagens (conversa_id, remetente, conteudo)
VALUES ($1, $2, $3);

-- Query Parameters — uso A (mensagem recebida do usuário):
-- {{ $('Buscar usuário').item.json.conversa_id }}, {{ 'usuario' }}, {{ $('Telegram Trigger').item.json.message.text }}

-- Query Parameters — uso B (resposta do bot; texto fixo até o RAG existir, Passo 6):
-- {{ $('Buscar usuário').item.json.conversa_id }}, {{ 'bot' }}, {{ 'Ainda estou aprendendo a responder — em breve vou usar nossa base de conhecimento.' }}


-- ===================================================================
-- Nó "Atualizar status"  (branch /humano)
-- ===================================================================
UPDATE conversas
SET status = 'aguardando_atendente'
WHERE usuario_id = $1 AND status <> 'encerrada';

-- Query Parameters:
-- {{ $('Buscar usuário').item.json.usuario_id }}

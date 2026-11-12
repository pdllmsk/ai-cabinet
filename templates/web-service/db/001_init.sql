-- Таблицы сервиса. Только схема app: её не видит автоматический API Supabase.
-- Новая таблица или столбец: новый файл db/002_<что>.sql. Старые файлы не правятся (они уже в базе).
create schema if not exists app;

create table if not exists app.zapisi (
  id serial primary key,
  nazvanie text not null,
  summa numeric(14, 2) not null default 0,
  sozdano timestamptz not null default now()
);

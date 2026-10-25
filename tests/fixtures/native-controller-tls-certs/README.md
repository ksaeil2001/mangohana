# Owned TLS test certificates

These files were generated for isolated native-controller TLS tests. They are fake
keys and certificates, not user or production credentials. Tests read only these
fixed fixture paths and connect to an explicitly owned loopback listener.

`owned-ca` signs the server, API, worker and unregistered identities. The API and
unregistered client certificates deliberately have the same CN; only a registered
DER certificate pin may confer the fixed peer role. `foreign-ca` signs a separate
client for the chain rejection case. The server SAN is
`server.native-controller.test.invalid`, and the normal client keeps Node's
default CA and hostname checks enabled.

CSR and CA material are retained as owned generation specimens. No fixture file
is an operational configuration or a physical host, database, provider, release
or certificate rotation proof.

package batlehub.jdt.core;

import java.util.List;
import org.eclipse.jdt.core.dom.CompilationUnit;

/**
 * One rule (RFC 0001 §6.2): an id under an area, a severity, and a visit over
 * a syntactic AST that reports findings, each carrying its own fix when one
 * is safe. Discovered through {@code META-INF/services}. Every rule here is
 * syntactic on purpose — no bindings, so it answers before indexing and the
 * same code path runs under JUnit over {@code ASTParser} and inside JDT.LS.
 */
public interface Inspection {
  String id();

  String area();

  /** {@code error | warning | info | hint} — the client applies overrides. */
  String severity();

  void visit(CompilationUnit cu, List<Finding> out);
}

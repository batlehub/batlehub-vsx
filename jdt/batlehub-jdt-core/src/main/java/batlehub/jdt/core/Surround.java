package batlehub.jdt.core;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTNode;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.Block;
import org.eclipse.jdt.core.dom.CatchClause;
import org.eclipse.jdt.core.dom.ClassInstanceCreation;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.IMethodBinding;
import org.eclipse.jdt.core.dom.ITypeBinding;
import org.eclipse.jdt.core.dom.MethodDeclaration;
import org.eclipse.jdt.core.dom.MethodInvocation;
import org.eclipse.jdt.core.dom.Modifier;
import org.eclipse.jdt.core.dom.NodeFinder;
import org.eclipse.jdt.core.dom.SimpleName;
import org.eclipse.jdt.core.dom.Statement;
import org.eclipse.jdt.core.dom.ThrowStatement;
import org.eclipse.jdt.core.dom.TryStatement;
import org.eclipse.jdt.core.dom.TypeDeclaration;
import org.eclipse.jdt.core.dom.VariableDeclarationFragment;
import org.eclipse.jdt.core.dom.VariableDeclarationStatement;
import org.eclipse.jdt.core.dom.rewrite.ASTRewrite;
import org.eclipse.jdt.core.dom.rewrite.ListRewrite;

/**
 * Surround with… (RFC 0015 §4.2, §5.2): the selection widened to the
 * smallest run of sibling statements of one block, moved — comments and
 * inner formatting kept — into the chosen construct. A local used after the
 * range is hoisted when its type is explicit; with `var` the command refuses.
 * Bindings, when the caller has them, give the precise catch type and the
 * AutoCloseable test; without, `Exception` and a name heuristic.
 */
public final class Surround {
  private Surround() {}

  public static final List<String> CONSTRUCTS =
      List.of("if", "ifElse", "while", "for", "tryCatch", "tryFinally", "tryWithResources", "synchronized", "runnable");

  public record Options(String construct, boolean precise) {
    public static Options of(Map<String, Object> m) {
      String c = String.valueOf(m.getOrDefault("construct", "tryCatch"));
      if (!CONSTRUCTS.contains(c)) throw new IllegalArgumentException("batlehub: unknown construct " + c + "; one of " + CONSTRUCTS);
      return new Options(c, !"Exception".equals(m.get("catchType")));
    }
  }

  /** The statements to move and the block they belong to, or the reason there are none. */
  record Range(Block block, List<Statement> statements, String refused) {}

  static Range range(CompilationUnit cu, int start, int end) {
    ASTNode covering = NodeFinder.perform(cu, start, Math.max(0, end - start));
    if (covering instanceof Block b && end > start) {
      List<Statement> in = new ArrayList<>();
      for (Object o : b.statements()) {
        Statement s = (Statement) o;
        if (s.getStartPosition() < end && start < s.getStartPosition() + s.getLength()) in.add(s);
      }
      if (!in.isEmpty()) return new Range(b, in, null);
      return new Range(null, null, "batlehub: no statement in the selection");
    }
    // A partial statement, or a cursor: the statement whose parent is a block.
    for (ASTNode n = covering; n != null; n = n.getParent())
      if (n instanceof Statement s && n.getParent() instanceof Block b) return new Range(b, List.of(s), null);
    return new Range(null, null, "batlehub: the selection is not inside a block of statements");
  }

  public static Builders.Result wrap(CompilationUnit cu, String source, int start, int end, Options o, String indent) {
    Range r = range(cu, start, end);
    if (r.refused() != null) return Builders.Result.refuse(cu, r.refused());
    List<Statement> stmts = r.statements();
    Statement first = stmts.get(0), last = stmts.get(stmts.size() - 1);
    AST ast = cu.getAST();
    ASTRewrite rewrite = ASTRewrite.create(ast);
    ListRewrite lr = rewrite.getListRewrite(r.block(), Block.STATEMENTS_PROPERTY);

    // Locals declared in the range and used after it.
    Set<String> after = namesAfter(r.block(), last);
    boolean resource = o.construct().equals("tryWithResources");
    List<VariableDeclarationStatement> hoist = new ArrayList<>();
    for (Statement s : stmts) {
      if (!(s instanceof VariableDeclarationStatement d)) continue;
      for (Object f : d.fragments()) {
        String name = ((VariableDeclarationFragment) f).getName().getIdentifier();
        if (!after.contains(name)) continue;
        if (d.getType().isVar()) return Builders.Result.refuse(cu, "batlehub: \"" + name + "\" is used after the selection and declared with var: declare its type, or widen the selection");
        if (resource && s == first) return Builders.Result.refuse(cu, "batlehub: the resource \"" + name + "\" is used after the selection, where it would be closed");
        if (!hoist.contains(d)) hoist.add(d);
      }
    }
    // The text each hoisted declaration becomes inside the construct ("" when nothing is assigned).
    Map<Statement, String> inside = new java.util.HashMap<>();
    for (VariableDeclarationStatement d : hoist) {
      // `Type a;` before the construct; inside, `a = init;` (nothing when there is no initializer).
      StringBuilder decl = new StringBuilder(d.getType().toString()).append(" ");
      List<String> assigns = new ArrayList<>();
      for (Object f : d.fragments()) {
        VariableDeclarationFragment v = (VariableDeclarationFragment) f;
        decl.append(decl.charAt(decl.length() - 1) == ' ' ? "" : ", ").append(v.getName().getIdentifier());
        if (v.getInitializer() != null) assigns.add(v.getName().getIdentifier() + " = " + v.getInitializer() + ";");
      }
      lr.insertBefore(rewrite.createStringPlaceholder(decl.append(";").toString(), ASTNode.VARIABLE_DECLARATION_STATEMENT), first, null);
      inside.put(d, String.join("\n", assigns));
      if (assigns.isEmpty()) rewrite.remove(d, null);
      else rewrite.replace(d, rewrite.createStringPlaceholder(String.join("\n", assigns), ASTNode.EXPRESSION_STATEMENT), null);
    }

    Block body = ast.newBlock();
    Statement wrapper;
    switch (o.construct()) {
      case "if", "ifElse" -> {
        var s = ast.newIfStatement();
        s.setExpression((org.eclipse.jdt.core.dom.Expression) rewrite.createStringPlaceholder("/* condition */ true", ASTNode.BOOLEAN_LITERAL));
        s.setThenStatement(body);
        if (o.construct().equals("ifElse")) s.setElseStatement(ast.newBlock());
        wrapper = s;
      }
      case "while" -> {
        var s = ast.newWhileStatement();
        s.setExpression((org.eclipse.jdt.core.dom.Expression) rewrite.createStringPlaceholder("/* condition */ true", ASTNode.BOOLEAN_LITERAL));
        s.setBody(body);
        wrapper = s;
      }
      case "for" -> wrapper = forLoop(ast, rewrite, body);
      case "synchronized" -> {
        var s = ast.newSynchronizedStatement();
        MethodDeclaration m = Engine.enclosing(cu, first.getStartPosition(), MethodDeclaration.class);
        TypeDeclaration t = Engine.enclosing(cu, first.getStartPosition(), TypeDeclaration.class);
        boolean isStatic = m != null && Modifier.isStatic(m.getModifiers());
        s.setExpression((org.eclipse.jdt.core.dom.Expression) rewrite.createStringPlaceholder(isStatic && t != null ? t.getName().getIdentifier() + ".class" : "this", ASTNode.SIMPLE_NAME));
        s.setBody(body);
        wrapper = s;
      }
      case "runnable" -> wrapper = runnable(ast, rewrite, body);
      default -> {
        TryStatement s = ast.newTryStatement();
        s.setBody(body);
        if (o.construct().equals("tryFinally")) s.setFinally(ast.newBlock());
        else {
          String types = "Exception";
          if (o.precise()) {
            List<String> thrown = checked(stmts, cu, rewrite);
            if (!thrown.isEmpty()) types = String.join(" | ", thrown);
          }
          CatchClause c = (CatchClause) rewrite.createStringPlaceholder("catch (" + types + " e) {\n" + indent + "throw new RuntimeException(e);\n}", ASTNode.CATCH_CLAUSE);
          s.catchClauses().add(c);
        }
        if (resource) {
          if (!(first instanceof VariableDeclarationStatement d) || d.fragments().size() != 1 || !closeable(d))
            return Builders.Result.refuse(cu, "batlehub: the first statement of the selection opens no resource (an AutoCloseable declared with an initializer)");
          String text = source.substring(d.getStartPosition(), d.getStartPosition() + d.getLength()).trim();
          s.resources().add(rewrite.createStringPlaceholder(text.endsWith(";") ? text.substring(0, text.length() - 1) : text, ASTNode.VARIABLE_DECLARATION_EXPRESSION));
        }
        wrapper = s;
      }
    }

    // The statements move into the construct; a resource declaration moves into its header instead.
    List<Statement> moved = resource ? stmts.subList(1, stmts.size()) : stmts;
    if (moved.isEmpty()) {
      lr.replace(first, wrapper, null);
      return new Builders.Result(rewrite, null, null, null);
    }
    if (resource) lr.remove(first, null);
    Statement only = moved.size() == 1 ? moved.get(0) : null;
    if (only != null && inside.containsKey(only)) {
      // A one-statement move is a replace of that statement, which would undo
      // its hoisting: its assignment goes into the construct as text instead.
      String text = inside.get(only);
      // The whole body as text: a new block holding only a placeholder is not formatted.
      swapBody(wrapper, (Block) rewrite.createStringPlaceholder(text.isEmpty() ? "{\n}" : "{\n" + indent + text.replace("\n", "\n" + indent) + "\n}", ASTNode.BLOCK));
      lr.replace(only, wrapper, null);
      return new Builders.Result(rewrite, null, null, null);
    }
    body.statements().add(lr.createMoveTarget(moved.get(0), moved.get(moved.size() - 1), wrapper, null));
    return new Builders.Result(rewrite, null, null, null);
  }

  static void swapBody(Statement wrapper, Block b) {
    if (wrapper instanceof TryStatement t) t.setBody(b);
    else if (wrapper instanceof org.eclipse.jdt.core.dom.IfStatement i) i.setThenStatement(b);
    else if (wrapper instanceof org.eclipse.jdt.core.dom.WhileStatement w) w.setBody(b);
    else if (wrapper instanceof org.eclipse.jdt.core.dom.ForStatement f) f.setBody(b);
    else if (wrapper instanceof org.eclipse.jdt.core.dom.SynchronizedStatement y) y.setBody(b);
    else if (wrapper instanceof VariableDeclarationStatement d)
      ((org.eclipse.jdt.core.dom.LambdaExpression) ((VariableDeclarationFragment) d.fragments().get(0)).getInitializer()).setBody(b);
  }

  static Statement forLoop(AST ast, ASTRewrite rewrite, Block body) {
    var f = ast.newForStatement();
    f.initializers().add(rewrite.createStringPlaceholder("int i = 0", ASTNode.VARIABLE_DECLARATION_EXPRESSION));
    f.setExpression((org.eclipse.jdt.core.dom.Expression) rewrite.createStringPlaceholder("i < /* n */ 0", ASTNode.INFIX_EXPRESSION));
    f.updaters().add(rewrite.createStringPlaceholder("i++", ASTNode.POSTFIX_EXPRESSION));
    f.setBody(body);
    return f;
  }

  static Statement runnable(AST ast, ASTRewrite rewrite, Block body) {
    var lambda = ast.newLambdaExpression();
    lambda.setParentheses(true);
    lambda.setBody(body);
    var frag = ast.newVariableDeclarationFragment();
    frag.setName(ast.newSimpleName("runnable"));
    frag.setInitializer(lambda);
    var decl = ast.newVariableDeclarationStatement(frag);
    decl.setType(ast.newSimpleType(ast.newSimpleName("Runnable")));
    return decl;
  }

  /** Identifiers used in the block after `last`: a syntactic answer, enough to know a local escapes. */
  static Set<String> namesAfter(Block block, Statement last) {
    Set<String> out = new LinkedHashSet<>();
    int from = last.getStartPosition() + last.getLength();
    for (Object o : block.statements()) {
      Statement s = (Statement) o;
      if (s.getStartPosition() < from) continue;
      s.accept(new ASTVisitor() {
        @Override
        public boolean visit(SimpleName n) {
          out.add(n.getIdentifier());
          return true;
        }
      });
    }
    return out;
  }

  /** The declared type implements AutoCloseable (bindings), or its initializer opens a stream, reader, writer, connection… (no bindings). */
  static boolean closeable(VariableDeclarationStatement d) {
    ITypeBinding t = d.getType().resolveBinding();
    if (t != null) return implementsCloseable(t);
    Object init = ((VariableDeclarationFragment) d.fragments().get(0)).getInitializer();
    return init != null && String.valueOf(init).matches("(?s).*\\bnew\\s+\\w*(Stream|Reader|Writer|Connection|Socket|Channel|Scanner|Client)\\b.*");
  }

  static boolean implementsCloseable(ITypeBinding t) {
    if (t == null) return false;
    if ("java.lang.AutoCloseable".equals(t.getErasure().getQualifiedName())) return true;
    for (ITypeBinding i : t.getInterfaces()) if (implementsCloseable(i)) return true;
    return implementsCloseable(t.getSuperclass());
  }

  /** The checked exceptions the statements throw (bindings), most general kept, imported when needed; empty without bindings. */
  static List<String> checked(List<Statement> stmts, CompilationUnit cu, ASTRewrite rewrite) {
    List<ITypeBinding> found = new ArrayList<>();
    for (Statement s : stmts)
      s.accept(new ASTVisitor() {
        @Override
        public boolean visit(TryStatement t) {
          return false; // what an inner try catches is its own business
        }

        @Override
        public boolean visit(MethodInvocation m) {
          add(m.resolveMethodBinding());
          return true;
        }

        @Override
        public boolean visit(ClassInstanceCreation c) {
          add(c.resolveConstructorBinding());
          return true;
        }

        @Override
        public boolean visit(ThrowStatement t) {
          addType(t.getExpression().resolveTypeBinding());
          return true;
        }

        void add(IMethodBinding b) {
          if (b != null) for (ITypeBinding e : b.getExceptionTypes()) addType(e);
        }

        void addType(ITypeBinding e) {
          if (e == null || !isChecked(e)) return;
          for (ITypeBinding f : found) if (e.isSubTypeCompatible(f)) return;
          found.removeIf(f -> f.isSubTypeCompatible(e));
          found.add(e);
        }
      });
    String pkg = cu.getPackage() == null ? "" : cu.getPackage().getName().getFullyQualifiedName();
    List<String> out = new ArrayList<>();
    for (ITypeBinding e : found) {
      String p = e.getPackage() == null ? "" : e.getPackage().getName();
      if (!p.equals("java.lang") && !p.equals(pkg)) Builders.importOnce(cu, rewrite, e.getErasure().getQualifiedName());
      out.add(e.getName());
    }
    return out;
  }

  static boolean isChecked(ITypeBinding t) {
    for (ITypeBinding s = t; s != null; s = s.getSuperclass()) {
      String q = s.getQualifiedName();
      if (q.equals("java.lang.RuntimeException") || q.equals("java.lang.Error")) return false;
    }
    return true;
  }
}

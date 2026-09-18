package batlehub.jdt.core.inspections;

import batlehub.jdt.core.Finding;
import java.util.List;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.Expression;
import org.eclipse.jdt.core.dom.MethodInvocation;
import org.eclipse.jdt.core.dom.StringLiteral;

/** `Objects.equals("lit", x)`: the literal is never null, `"lit".equals(x)` says so. */
public final class ObjectsEqualsLiteral extends Base {
  public ObjectsEqualsLiteral() {
    super("correctness", "objectsEqualsLiteral", "info");
  }

  @Override
  public void visit(CompilationUnit cu, List<Finding> out) {
    cu.accept(new ASTVisitor() {
      @Override
      public boolean visit(MethodInvocation m) {
        if (!m.getName().getIdentifier().equals("equals") || m.arguments().size() != 2 || m.getExpression() == null || !m.getExpression().toString().endsWith("Objects")) return true;
        Expression a = (Expression) m.arguments().get(0), b = (Expression) m.arguments().get(1);
        StringLiteral lit = a instanceof StringLiteral s ? s : b instanceof StringLiteral s2 ? s2 : null;
        if (lit == null) return true;
        Expression other = lit == a ? b : a;
        out.add(new Finding(ObjectsEqualsLiteral.this, m, "Objects.equals on a literal: the literal is never null", "Replace with " + lit + ".equals(…)", rw -> {
          AST ast = m.getAST();
          MethodInvocation r = ast.newMethodInvocation();
          r.setExpression((Expression) rw.createCopyTarget(lit));
          r.setName(ast.newSimpleName("equals"));
          r.arguments().add(rw.createCopyTarget(other));
          rw.replace(m, r, null);
        }));
        return true;
      }
    });
  }
}
